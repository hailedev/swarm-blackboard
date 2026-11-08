import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { ModelRequest } from '../ports/model';
import { createFakeModel } from './fake-model';

const AnswerSchema = z.object({ answer: z.string(), confidence: z.number().min(0).max(1) });

const request = (prompt = 'q'): ModelRequest<z.infer<typeof AnswerSchema>> => ({
  schema: AnswerSchema,
  system: 'You answer.',
  prompt,
  tags: { role: 'solver', runId: 'run', round: 1 },
});

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
        },
      ],
    });

    const first = await model.generateObject(request('one'));
    const second = await model.generateObject(request('two'));

    expect(first.ok && first.value.object.answer).toBe('a');
    expect(first.ok && first.value.usage).toEqual({ inputTokens: 0, outputTokens: 0, costUsd: 0 });
    expect(first.ok && first.value.modelId).toBe('scripted');
    expect(second.ok && second.value.object.confidence).toBe(0.9);
    expect(second.ok && second.value.usage.inputTokens).toBe(7);
    expect(second.ok && second.value.latencyMs).toBe(42);
    expect(model.calls.map((c) => [c.index, c.request.prompt, c.outcome])).toEqual([
      [0, 'one', 'ok'],
      [1, 'two', 'ok'],
    ]);
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

  it('reports invalid scripted output the way a real model would', async () => {
    const model = createFakeModel({ script: [{ object: { answer: 'a', confidence: 3 } }] });
    const result = await model.generateObject(request());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('invalid_output');
      if (result.error.kind === 'invalid_output') {
        expect(result.error.issues[0]).toMatch(/^confidence: /);
        expect(result.error.raw).toBe('{"answer":"a","confidence":3}');
      }
    }
    expect(model.calls[0]?.outcome).toBe('invalid_output');
  });

  it('passes scripted errors through', async () => {
    const model = createFakeModel({
      script: [{ error: { kind: 'provider_error', message: 'boom' } }],
    });
    const result = await model.generateObject(request());
    expect(!result.ok && result.error).toEqual({ kind: 'provider_error', message: 'boom' });
    expect(model.calls[0]?.outcome).toBe('provider_error');
  });

  it('fails with script_exhausted once the script runs out', async () => {
    const model = createFakeModel({ script: [] });
    const result = await model.generateObject(request());
    expect(!result.ok && result.error).toEqual({ kind: 'script_exhausted', calls: 0 });
    const again = await model.generateObject(request());
    expect(!again.ok && again.error).toEqual({ kind: 'script_exhausted', calls: 1 });
  });
});
