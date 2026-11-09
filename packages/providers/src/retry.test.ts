import { createFakeModel, type FakeResponse, type ModelRequest } from '@team/core';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { backoffDelayMs, withRetry } from './retry';

const Schema = z.object({ answer: z.string() });
const request: ModelRequest<z.infer<typeof Schema>> = {
  schema: Schema,
  system: 's',
  prompt: 'p',
  tags: { role: 'solver', runId: 'run', round: 1 },
};

const rateLimited: FakeResponse = { error: { kind: 'rate_limit', message: '429', attempts: 1 } };
const fine: FakeResponse = { object: { answer: 'ok' }, usage: { inputTokens: 1, outputTokens: 1 } };

const recordingSleep = () => {
  const delays: number[] = [];
  return { delays, sleep: (ms: number) => Promise.resolve(void delays.push(ms)) };
};

describe('withRetry', () => {
  it('backs off exponentially from one second', () => {
    expect([1, 2, 3].map((attempt) => backoffDelayMs(attempt, 1_000))).toEqual([1000, 2000, 4000]);
  });

  it('retries transient errors three times in all, then reports the attempt count', async () => {
    const inner = createFakeModel({ script: [rateLimited, rateLimited, rateLimited, fine] });
    const { delays, sleep } = recordingSleep();
    const result = await withRetry(inner, { sleep }).generateObject(request);
    expect(result).toEqual({
      ok: false,
      error: { kind: 'rate_limit', message: '429', attempts: 3 },
    });
    expect(inner.calls.length).toBe(3);
    expect(delays).toEqual([1000, 2000]);
  });

  it('succeeds as soon as a retry works', async () => {
    const inner = createFakeModel({
      script: [{ error: { kind: 'network', message: 'fetch failed', attempts: 1 } }, fine],
    });
    const { delays, sleep } = recordingSleep();
    const result = await withRetry(inner, { sleep }).generateObject(request);
    expect(result.ok && result.value.object.answer).toBe('ok');
    expect(delays).toEqual([1000]);
  });

  it.each([
    ['billing', { kind: 'billing', message: 'credit balance too low' }],
    ['auth', { kind: 'auth', message: '401' }],
    ['invalid_request', { kind: 'invalid_request', message: '400' }],
  ] as const)('never retries a %s error', async (_kind, error) => {
    const inner = createFakeModel({ script: [{ error }, fine] });
    const { delays, sleep } = recordingSleep();
    const result = await withRetry(inner, { sleep }).generateObject(request);
    expect(!result.ok && result.error).toEqual(error);
    expect(inner.calls.length).toBe(1);
    expect(delays).toEqual([]);
  });

  it('never retries a schema failure: that is the repair path, not a provider error', async () => {
    const inner = createFakeModel({ script: [{ object: { answer: 1 } }, fine] });
    const { sleep } = recordingSleep();
    const result = await withRetry(inner, { sleep }).generateObject(request);
    expect(!result.ok && result.error.kind).toBe('invalid_output');
    expect(inner.calls.length).toBe(1);
  });

  it('honours a custom policy and keeps the model identity, billing and pricing', async () => {
    const inner = createFakeModel({
      id: 'haiku',
      billing: 'api',
      script: [rateLimited, rateLimited],
    });
    const { delays, sleep } = recordingSleep();
    const wrapped = withRetry(inner, { attempts: 2, baseDelayMs: 50, sleep });
    expect([wrapped.id, wrapped.billing, wrapped.pricing]).toEqual(['haiku', 'api', null]);
    const result = await wrapped.generateObject(request);
    expect(!result.ok && result.error).toEqual({ kind: 'rate_limit', message: '429', attempts: 2 });
    expect(delays).toEqual([50]);
  });
});
