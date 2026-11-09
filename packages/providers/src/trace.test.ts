import { createFakeModel, type ModelRequest } from '@team/core';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { traceModel, type ModelCallTrace } from './trace';

const Schema = z.object({ answer: z.string() });
const request: ModelRequest<z.infer<typeof Schema>> = {
  schema: Schema,
  system: 'be brief',
  prompt: 'what?',
  maxOutputTokens: 512,
  tags: { role: 'critic', runId: 'run-1', round: 2 },
};

const pricing = {
  tiers: [
    {
      upToPromptTokens: null,
      inputPerMTok: 1,
      outputPerMTok: 5,
      cacheReadPerMTok: 0.1,
      cacheWritePerMTok: 1.25,
    },
  ],
};

const harness = (script: Parameters<typeof createFakeModel>[0]['script']) => {
  const traces: ModelCallTrace[] = [];
  const inner = createFakeModel({ id: 'haiku', billing: 'api', pricing, script });
  let tick = 1_767_225_600_000;
  const traced = traceModel(
    inner,
    (trace) => traces.push(trace),
    () => (tick += 25),
  );
  return { traces, traced, inner };
};

describe('traceModel', () => {
  it('records a successful call with its prompt, response, usage and latency', async () => {
    const { traces, traced } = harness([
      {
        object: { answer: 'yes' },
        usage: { inputTokens: 100, outputTokens: 10 },
        warnings: ['unsupported setting: topK'],
      },
    ]);
    const result = await traced.generateObject(request);
    expect(result.ok).toBe(true);
    expect(traces).toEqual([
      {
        at: '2026-01-01T00:00:00.025Z',
        modelId: 'haiku',
        billing: 'api',
        tags: { role: 'critic', runId: 'run-1', round: 2 },
        request: { system: 'be brief', prompt: 'what?', maxOutputTokens: 512 },
        outcome: 'ok',
        usage: {
          inputTokens: 100,
          outputTokens: 10,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          costUsd: expect.closeTo(0.0001 + 0.00005, 12) as number,
        },
        // 'be brief' + 'what?' is 13 characters: ⌈13 / 3⌉ + 1000.
        estimatedInputTokens: 1005,
        actualInputTokens: 100,
        warnings: ['unsupported setting: topK'],
        latencyMs: 25,
        response: { answer: 'yes' },
        error: null,
      },
    ]);
  });

  it('records the raw text and billed tokens of a rejected answer', async () => {
    const { traces, traced } = harness([
      { object: { answer: 7 }, usage: { inputTokens: 50, outputTokens: 5 } },
    ]);
    await traced.generateObject(request);
    expect(traces[0]).toMatchObject({
      outcome: 'invalid_output',
      usage: { inputTokens: 50, outputTokens: 5 },
      estimatedInputTokens: 1005,
      actualInputTokens: 50,
      warnings: [],
      response: '{"answer":7}',
      error: expect.stringContaining('answer') as string,
    });
  });

  it('records provider failures with no usage', async () => {
    const { traces, traced } = harness([
      { error: { kind: 'rate_limit', message: '429', attempts: 3 } },
    ]);
    await traced.generateObject(request);
    expect(traces[0]).toMatchObject({
      outcome: 'rate_limit',
      usage: null,
      actualInputTokens: null,
      warnings: [],
      response: null,
      error: '429',
    });
  });

  it('counts cache tokens as prompt tokens, and treats a zero count as not reported', async () => {
    const { traces, traced } = harness([
      {
        object: { answer: 'a' },
        usage: { inputTokens: 10, outputTokens: 1, cacheReadTokens: 30, cacheWriteTokens: 5 },
      },
      { object: { answer: 'b' }, usage: { inputTokens: 0, outputTokens: 0 } },
    ]);
    await traced.generateObject(request);
    await traced.generateObject(request);
    expect(traces.map((t) => t.actualInputTokens)).toEqual([45, null]);
  });

  it('keeps the wrapped model identity', () => {
    const { traced } = harness([]);
    expect([traced.id, traced.billing, traced.pricing]).toEqual(['haiku', 'api', pricing]);
  });
});
