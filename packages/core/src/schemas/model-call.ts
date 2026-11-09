import { z } from 'zod';

import type { ModelErrorKind } from '../ports/model';
import { IsoDateSchema, RoundSchema, UsageSchema } from './common';

// One traced model call (CLAUDE.md architecture rule 6): prompt, response, tokens, cost,
// latency, plus the reservation estimate beside the count the provider reported. The
// provider layer produces these; hosts store them (the model_calls table) and read them
// back for the spend ledger, the trace viewer and the chars-per-token calibration.

/** Who gets the bill. `api` calls land in the spend ledger; the others only record tokens. */
export const ModelBillingSchema = z.enum(['api', 'local', 'fake']);
export type ModelBilling = z.infer<typeof ModelBillingSchema>;

export const ModelCallOutcomeSchema = z.enum([
  'ok',
  'invalid_output',
  'billing',
  'auth',
  'rate_limit',
  'overloaded',
  'invalid_request',
  'network',
  'script_exhausted',
]);
export type ModelCallOutcome = z.infer<typeof ModelCallOutcomeSchema>;
// Every model error kind is an outcome; a new kind must be added above too.
type OutcomesCoverErrors = [ModelErrorKind] extends [Exclude<ModelCallOutcome, 'ok'>]
  ? true
  : never;
export const OUTCOMES_COVER_ERRORS: OutcomesCoverErrors = true;

/** The controller's reservation estimate for the prompt (docs/budget-guardrails.md §2). */
export const InputEstimateSchema = z.object({
  chars: z.int().nonnegative(),
  charsPerToken: z.number().positive(),
  tokens: z.int().nonnegative(),
});

export const ModelCallTagsSchema = z.object({
  role: z.string().min(1),
  runId: z.string().min(1),
  round: RoundSchema,
});

export const ModelCallTraceSchema = z.object({
  at: IsoDateSchema,
  modelId: z.string().min(1),
  billing: ModelBillingSchema,
  tags: ModelCallTagsSchema,
  request: z.object({
    system: z.string(),
    prompt: z.string(),
    maxOutputTokens: z.int().positive().nullable(),
  }),
  outcome: ModelCallOutcomeSchema,
  /** Null when the call failed before the model produced anything billable. */
  usage: UsageSchema.nullable(),
  estimate: InputEstimateSchema,
  /** Prompt tokens the provider reported (input + cache reads + writes); null when none. */
  actualInputTokens: z.int().nonnegative().nullable(),
  /** Provider warnings, e.g. a setting the model does not support. */
  warnings: z.array(z.string()).readonly(),
  latencyMs: z.int().nonnegative(),
  /** The validated object, the raw text of a rejected answer, or null. */
  response: z.unknown(),
  error: z.string().nullable(),
});
export type ModelCallTrace = z.infer<typeof ModelCallTraceSchema>;
