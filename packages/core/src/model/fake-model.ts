import type { Model, ModelError, ModelRequest, ModelResponse } from '../ports/model';
import { err, ok, type Result } from '../ports/result';
import { zeroUsage, type Usage } from '../schemas/common';

export type FakeResponse =
  { object: unknown; usage?: Usage; latencyMs?: number } | { error: ModelError };

// Either a fixed list consumed in call order, or a function of the request.
export type FakeScript =
  | readonly FakeResponse[]
  | ((request: ModelRequest<unknown>, callIndex: number) => FakeResponse | undefined);

export interface FakeModelOptions {
  id?: string;
  script: FakeScript;
  defaultUsage?: Usage;
}

export interface RecordedCall {
  index: number;
  request: ModelRequest<unknown>;
  outcome: 'ok' | ModelError['kind'];
}

export interface FakeModel extends Model {
  readonly calls: readonly RecordedCall[];
}

const pick = (script: FakeScript, request: ModelRequest<unknown>, index: number) =>
  typeof script === 'function' ? script(request, index) : script[index];

// A scripted Model. Scripted objects are validated against the request schema,
// so a bad script fails exactly the way a misbehaving real model would.
export const createFakeModel = (options: FakeModelOptions): FakeModel => {
  const id = options.id ?? 'fake';
  const defaultUsage = options.defaultUsage ?? zeroUsage();
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
    const parsed = request.schema.safeParse(response.object);
    if (!parsed.success) {
      record(erased, 'invalid_output');
      return Promise.resolve(
        err({
          kind: 'invalid_output',
          issues: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
          raw: JSON.stringify(response.object),
        }),
      );
    }
    record(erased, 'ok');
    return Promise.resolve(
      ok({
        object: parsed.data,
        usage: response.usage ?? defaultUsage,
        latencyMs: response.latencyMs ?? 0,
        modelId: id,
      }),
    );
  };

  return { id, calls, generateObject };
};
