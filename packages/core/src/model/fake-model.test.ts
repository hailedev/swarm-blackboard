import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { ModelRequest } from '../ports/model';
import type { ModelPricing } from '../schemas/pricing';
import { createFakeModel } from './fake-model';

const AnswerSchema = z.object({ answer: z.string(), confidence: z.number().min(0).max(1) });

const request = (prompt = 'q'): ModelRequest<z.infer<typeof AnswerSchema>> => ({
  schema: AnswerSchema,
  system: 'You answer.',
  prompt,
  tags: { role: 'solver', runId: 'run', round: 1 },
});

// $1 per million in, $5 out, cache reads at a tenth and writes at 1.25x.
const pricing: ModelPricing = {
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

describe('createFakeModel', () => {
  it('replays a list script in order, validating each object and recording calls', async () => {
    const model = createFakeModel({
      id: 'scripted',
      script: [
        { object: { answer: 'a', confidence: 0.5 } },
        {
          object: { answer: 'b', confidence: 0.9 },
          usage: { inputTokens: 7, outputTokens: 3, costUsd: 0.01 },
          latencyMs: 42,
          warnings: ['topK unsupported'],
        },
      ],
    });

    const first = await model.generateObject(request('one'));
    const second = await model.generateObject(request('two'));

    expect(first.ok && first.value.object.answer).toBe('a');
    expect(first.ok && first.value.usage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      costUsd: 0,
    });
    expect(first.ok && first.value.modelId).toBe('scripted');
    expect(first.ok && first.value.warnings).toEqual([]);
    expect(second.ok && second.value.object.confidence).toBe(0.9);
    expect(second.ok && second.value.usage.inputTokens).toBe(7);
    expect(second.ok && second.value.usage.costUsd).toBe(0.01);
    expect(second.ok && second.value.latencyMs).toBe(42);
    expect(second.ok && second.value.warnings).toEqual(['topK unsupported']);
    expect(model.calls.map((c) => [c.index, c.request.prompt, c.outcome])).toEqual([
      [0, 'one', 'ok'],
      [1, 'two', 'ok'],
    ]);
    expect(model.billing).toBe('fake');
    expect(model.pricing).toBeNull();
  });

  it('supports a function script that sees the request and call index', async () => {
    const model = createFakeModel({
      script: (req, index) => ({
        object: { answer: `${req.tags.role}#${String(index)}`, confidence: 1 },
      }),
      defaultUsage: { inputTokens: 1, outputTokens: 1, costUsd: 0.001 },
    });
    const result = await model.generateObject(request());
    expect(result.ok && result.value.object.answer).toBe('solver#0');
    expect(result.ok && result.value.usage.costUsd).toBe(0.001);
    expect(model.id).toBe('fake');
  });

  it('prices usage from its price table when the script gives tokens only', async () => {
    const model = createFakeModel({
      pricing,
      billing: 'api',
      script: [
        {
          object: { answer: 'a', confidence: 1 },
          usage: { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 500 },
        },
        {
          object: { answer: 'b', confidence: 1 },
          usage: { inputTokens: 1000, outputTokens: 200, costUsd: 0.5 },
        },
      ],
    });
    const priced = await model.generateObject(request());
    expect(priced.ok && priced.value.usage).toEqual({
      inputTokens: 1000,
      outputTokens: 200,
      cacheReadTokens: 500,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      costUsd: expect.closeTo(0.001 + 0.001 + 0.00005, 10) as number,
    });
    const explicit = await model.generateObject(request());
    expect(explicit.ok && explicit.value.usage.costUsd).toBe(0.5);
    expect(model.billing).toBe('api');
  });

  it('reports invalid scripted output the way a real model would, tokens included', async () => {
    const model = createFakeModel({
      pricing,
      script: [
        { object: { answer: 'a', confidence: 3 }, usage: { inputTokens: 100, outputTokens: 50 } },
      ],
    });
    const result = await model.generateObject(request());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('invalid_output');
      if (result.error.kind === 'invalid_output') {
        expect(result.error.issues[0]).toMatch(/^confidence: /);
        expect(result.error.raw).toBe('{"answer":"a","confidence":3}');
        expect(result.error.usage.outputTokens).toBe(50);
        expect(result.error.usage.costUsd).toBeCloseTo(0.0001 + 0.00025, 10);
      }
    }
    expect(model.calls[0]?.outcome).toBe('invalid_output');
  });

  it('passes scripted errors through', async () => {
    const model = createFakeModel({
      script: [{ error: { kind: 'billing', message: 'credit balance too low' } }],
    });
    const result = await model.generateObject(request());
    expect(!result.ok && result.error).toEqual({
      kind: 'billing',
      message: 'credit balance too low',
    });
    expect(model.calls[0]?.outcome).toBe('billing');
  });

  it('fails with script_exhausted once the script runs out', async () => {
    const model = createFakeModel({ script: [] });
    const result = await model.generateObject(request());
    expect(!result.ok && result.error).toEqual({ kind: 'script_exhausted', calls: 0 });
    const again = await model.generateObject(request());
    expect(!again.ok && again.error).toEqual({ kind: 'script_exhausted', calls: 1 });
  });
});

describe('createFakeModel: chars per token', () => {
  it('assumes the default unless told otherwise', () => {
    expect(createFakeModel({ script: [] }).charsPerToken).toBe(3);
    expect(createFakeModel({ script: [], charsPerToken: 2 }).charsPerToken).toBe(2);
  });
});
