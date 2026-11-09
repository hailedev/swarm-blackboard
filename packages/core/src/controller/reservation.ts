import { outputTokenCostUsd, worstCaseCostUsd, type ModelPricing } from '../schemas/pricing';

/** Below this a structured contribution cannot be valid, so the call is skipped instead. */
export const MIN_OUTPUT_TOKENS = 256;

// Conservative input estimate (docs/budget-guardrails.md §2). Board views are dense with
// ids, which tokenise badly, so assume three characters per token rather than the usual
// four, and add a flat allowance for the JSON schema the provider sends as a tool
// definition. The actual usage replaces this estimate once the call returns.
export const ESTIMATE_CHARS_PER_TOKEN = 3;
export const SCHEMA_OVERHEAD_TOKENS = 1_000;

export const estimateInputTokens = (request: { system: string; prompt: string }): number =>
  Math.ceil((request.system.length + request.prompt.length) / ESTIMATE_CHARS_PER_TOKEN) +
  SCHEMA_OVERHEAD_TOKENS;

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
