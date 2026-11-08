import type { ZodType } from 'zod';

import type { Usage } from '../schemas/common';
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
  maxOutputTokens?: number;
  tags: ModelCallTags;
}

export interface ModelResponse<T> {
  object: T;
  usage: Usage;
  latencyMs: number;
  modelId: string;
}

export type ModelError =
  | { kind: 'invalid_output'; issues: readonly string[]; raw: string }
  | { kind: 'provider_error'; message: string }
  | { kind: 'timeout'; afterMs: number }
  | { kind: 'script_exhausted'; calls: number };

export interface Model {
  readonly id: string;
  generateObject<T>(request: ModelRequest<T>): Promise<Result<ModelResponse<T>, ModelError>>;
}
