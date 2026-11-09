import {
  DEFAULT_CHARS_PER_TOKEN,
  type Model,
  type ModelBilling,
  type ModelError,
  type ModelRequest,
  type ModelResponse,
} from '../ports/model';
import { err, ok, type Result } from '../ports/result';
import type { Usage } from '../schemas/common';
import { withCost, type ModelPricing } from '../schemas/pricing';

// Token counts a script reports. Cache counts default to zero; cost defaults to the
// price table (a fake can be priced like a real model) or zero when unpriced.
export interface FakeUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUsd?: number;
}

export type FakeResponse =
  | { object: unknown; usage?: FakeUsage; latencyMs?: number; warnings?: readonly string[] }
  | { error: ModelError };

// Either a fixed list consumed in call order, or a function of the request.
export type FakeScript =
  | readonly FakeResponse[]
  | ((request: ModelRequest<unknown>, callIndex: number) => FakeResponse | undefined);

export interface FakeModelOptions {
  id?: string;
  script: FakeScript;
  defaultUsage?: FakeUsage;
  pricing?: ModelPricing | null;
  billing?: ModelBilling;
  /** For the reservation estimate; fakes default to DEFAULT_CHARS_PER_TOKEN. */
  charsPerToken?: number;
}

export interface RecordedCall {
  index: number;
  request: ModelRequest<unknown>;
  outcome: 'ok' | ModelError['kind'];
}

export interface FakeModel extends Model {
  readonly calls: readonly RecordedCall[];
}

const ZERO_FAKE_USAGE: FakeUsage = { inputTokens: 0, outputTokens: 0 };

const pick = (script: FakeScript, request: ModelRequest<unknown>, index: number) =>
  typeof script === 'function' ? script(request, index) : script[index];

const toUsage = (fake: FakeUsage, pricing: ModelPricing | null): Usage => {
  const tokens = {
    inputTokens: fake.inputTokens,
    outputTokens: fake.outputTokens,
    cacheReadTokens: fake.cacheReadTokens ?? 0,
    cacheWriteTokens: fake.cacheWriteTokens ?? 0,
  };
  return fake.costUsd === undefined
    ? withCost(tokens, pricing)
    : { ...tokens, costUsd: fake.costUsd };
};

// A scripted Model. Scripted objects are validated against the request schema,
// so a bad script fails exactly the way a misbehaving real model would, and the
// tokens it burned are still reported.
export const createFakeModel = (options: FakeModelOptions): FakeModel => {
  const id = options.id ?? 'fake';
  const pricing = options.pricing ?? null;
  const defaultUsage = options.defaultUsage ?? ZERO_FAKE_USAGE;
  const calls: RecordedCall[] = [];

  const record = (request: ModelRequest<unknown>, outcome: RecordedCall['outcome']): void => {
    calls.push({ index: calls.length, request, outcome });
  };

  const generateObject = <T>(
    request: ModelRequest<T>,
  ): Promise<Result<ModelResponse<T>, ModelError>> => {
    const erased = request as ModelRequest<unknown>;
    const callIndex = calls.length;
    const response = pick(options.script, erased, callIndex);
    if (response === undefined) {
      record(erased, 'script_exhausted');
      return Promise.resolve(err({ kind: 'script_exhausted', calls: callIndex }));
    }
    if ('error' in response) {
      record(erased, response.error.kind);
      return Promise.resolve(err(response.error));
    }
    const usage = toUsage(response.usage ?? defaultUsage, pricing);
    const parsed = request.schema.safeParse(response.object);
    if (!parsed.success) {
      record(erased, 'invalid_output');
      return Promise.resolve(
        err({
          kind: 'invalid_output',
          issues: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
          raw: JSON.stringify(response.object),
          usage,
        }),
      );
    }
    record(erased, 'ok');
    return Promise.resolve(
      ok({
        object: parsed.data,
        usage,
        latencyMs: response.latencyMs ?? 0,
        modelId: id,
        warnings: response.warnings ?? [],
      }),
    );
  };

  return {
    id,
    billing: options.billing ?? 'fake',
    pricing,
    charsPerToken: options.charsPerToken ?? DEFAULT_CHARS_PER_TOKEN,
    calls,
    generateObject,
  };
};
