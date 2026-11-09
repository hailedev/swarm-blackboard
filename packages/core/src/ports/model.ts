import type { ZodType } from 'zod';

import type { Usage } from '../schemas/common';
import type { ModelPricing } from '../schemas/pricing';
import type { Result } from './result';

// The only way core talks to a language model (ADR-0003). packages/providers
// implements this with the AI SDK; FakeModel implements it with a script.
export interface ModelCallTags {
  role: string;
  runId: string;
  round: number;
}

export interface ModelRequest<T> {
  schema: ZodType<T>;
  system: string;
  prompt: string;
  /** Output allowance. The controller may lower it to fit the remaining budget. */
  maxOutputTokens?: number;
  tags: ModelCallTags;
}

export interface ModelResponse<T> {
  object: T;
  usage: Usage;
  latencyMs: number;
  modelId: string;
  /** Provider warnings, e.g. a setting the model does not support. Empty when none. */
  warnings: readonly string[];
}

// Every failure the provider layer can report, classified so the controller never has
// to guess (docs/budget-guardrails.md §4). `attempts` counts tries including retries.
export type ModelError =
  | { kind: 'invalid_output'; issues: readonly string[]; raw: string; usage: Usage }
  | { kind: 'billing'; message: string }
  | { kind: 'auth'; message: string }
  | { kind: 'rate_limit'; message: string; attempts: number }
  | { kind: 'overloaded'; message: string; attempts: number }
  | { kind: 'invalid_request'; message: string }
  | { kind: 'network'; message: string; attempts: number }
  | { kind: 'script_exhausted'; calls: number };

export type ModelErrorKind = ModelError['kind'];

/** Errors worth retrying with backoff. Everything else is terminal for the call. */
export const RETRYABLE_MODEL_ERRORS: readonly ModelErrorKind[] = [
  'rate_limit',
  'overloaded',
  'network',
];

// Who gets the bill for a call. `api` calls land in the spend ledger; the others only
// record tokens.
export type ModelBilling = 'api' | 'local' | 'fake';

export interface Model {
  readonly id: string;
  readonly billing: ModelBilling;
  /** Null for local and fake models: they are free, but their tokens are still recorded. */
  readonly pricing: ModelPricing | null;
  generateObject<T>(request: ModelRequest<T>): Promise<Result<ModelResponse<T>, ModelError>>;
}
