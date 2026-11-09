import { z, type ZodType } from 'zod';

import { outputTokenCostUsd, worstCaseCostUsd, type ModelPricing } from '../schemas/pricing';

/** Below this a structured contribution cannot be valid, so the call is skipped instead. */
export const MIN_OUTPUT_TOKENS = 256;

// Input estimate (docs/budget-guardrails.md §2): the characters a call sends — system
// prompt, user prompt and the JSON schema the provider receives — divided by the model's
// chars-per-token figure. The figure is a provider default until the host has calibrated it
// from the model's own traces. The actual usage replaces the estimate once the call returns.

/** Stands in for the schema's size when it cannot be rendered as JSON Schema. */
export const SCHEMA_FALLBACK_CHARS = 3_000;

export interface EstimateInput {
  system: string;
  prompt: string;
  schema?: ZodType;
}

export interface InputEstimate {
  /** Characters counted: system + prompt + serialised schema. */
  chars: number;
  charsPerToken: number;
  tokens: number;
}

/** Length of the schema as the provider will see it, or the fallback when it has no JSON form. */
export const schemaChars = (schema: ZodType | undefined): number => {
  if (schema === undefined) return SCHEMA_FALLBACK_CHARS;
  try {
    return JSON.stringify(z.toJSONSchema(schema)).length;
  } catch {
    return SCHEMA_FALLBACK_CHARS;
  }
};

export const estimateInput = (request: EstimateInput, charsPerToken: number): InputEstimate => {
  const chars = request.system.length + request.prompt.length + schemaChars(request.schema);
  return { chars, charsPerToken, tokens: Math.ceil(chars / charsPerToken) };
};

export const estimateInputTokens = (request: EstimateInput, charsPerToken: number): number =>
  estimateInput(request, charsPerToken).tokens;

// The estimate only has to be conservative. When a model reports materially more prompt
// tokens than estimated, the reservation was too small, so the controller says so.
export const ESTIMATE_UNDERSHOOT_WARN_FRACTION = 0.2;

export const estimateUndershot = (estimatedTokens: number, actualTokens: number): boolean =>
  actualTokens > estimatedTokens * (1 + ESTIMATE_UNDERSHOOT_WARN_FRACTION);

export interface FitInput {
  pricing: ModelPricing | null;
  inputTokens: number;
  maxOutputTokens: number;
  remainingUsd: number;
}

export type Fit =
  | { fits: true; maxOutputTokens: number; worstCaseUsd: number; shrunk: boolean }
  /** `worstCaseUsd` here is the cost of the smallest call that would still be useful. */
  | { fits: false; remainingUsd: number; worstCaseUsd: number };

// Will the call fit the remaining budget? First as requested; then with the output
// allowance shrunk towards the floor; otherwise not at all.
// Dollar arithmetic in binary floating point: 0.005 - 0.00125 is not exactly 0.00375, so
// comparisons and the floor get a tolerance far below a thousandth of a cent.
const EPSILON_USD = 1e-12;
const EPSILON_TOKENS = 1e-6;

export const fitCall = ({ pricing, inputTokens, maxOutputTokens, remainingUsd }: FitInput): Fit => {
  if (pricing === null) return { fits: true, maxOutputTokens, worstCaseUsd: 0, shrunk: false };
  const full = worstCaseCostUsd(pricing, inputTokens, maxOutputTokens);
  if (full <= remainingUsd + EPSILON_USD) {
    return { fits: true, maxOutputTokens, worstCaseUsd: full, shrunk: false };
  }
  const promptOnly = worstCaseCostUsd(pricing, inputTokens, 0);
  const perOutputToken = outputTokenCostUsd(pricing, inputTokens);
  const affordable =
    perOutputToken > 0
      ? Math.floor((remainingUsd - promptOnly) / perOutputToken + EPSILON_TOKENS)
      : 0;
  if (affordable >= MIN_OUTPUT_TOKENS) {
    const allowance = Math.min(affordable, maxOutputTokens);
    return {
      fits: true,
      maxOutputTokens: allowance,
      worstCaseUsd: worstCaseCostUsd(pricing, inputTokens, allowance),
      shrunk: true,
    };
  }
  return {
    fits: false,
    remainingUsd,
    worstCaseUsd: worstCaseCostUsd(pricing, inputTokens, MIN_OUTPUT_TOKENS),
  };
};
