import { createFakeModel, MIN_OUTPUT_TOKENS } from '@team/core';
import { SCENARIO_PRICING } from '@team/core/testing';
import { describe, expect, it } from 'vitest';

import {
  baselineCacheKey,
  baselinePrompt,
  hitAllowance,
  BaselineRecordSchema,
  describeBaselineError,
  generateBaseline,
  sizeBaseline,
  wordBudgetFor,
} from './baseline';
import type { Problem } from './problems';

const problem: Problem = {
  id: 'demo',
  title: 'Demo',
  domain: 'test',
  constraints: ['c1'],
  successCriteria: ['s1'],
  rubric: [
    { id: 'a', weight: 1, criterion: 'A', scale: 's' },
    { id: 'b', weight: 1, criterion: 'B', scale: 's' },
    { id: 'c', weight: 1, criterion: 'C', scale: 's' },
  ],
  statement: 'Do the thing.',
};

const tags = { role: 'eval-baseline', runId: 'eval:p1', round: 0 };

describe('baselineCacheKey', () => {
  it('changes with the problem text and the model, not with anything else', () => {
    const key = baselineCacheKey(problem, 'm1');
    expect(key).toBe(baselineCacheKey({ ...problem, title: 'Other title' }, 'm1'));
    expect(key).not.toBe(baselineCacheKey({ ...problem, statement: 'Do another thing.' }, 'm1'));
    expect(key).not.toBe(baselineCacheKey({ ...problem, constraints: ['c2'] }, 'm1'));
    expect(key).not.toBe(baselineCacheKey(problem, 'm2'));
  });
});

describe('sizeBaseline and generateBaseline', () => {
  it('fits the call under the cap by shrinking the output allowance, and records what it did', async () => {
    const model = createFakeModel({
      id: 'fake-baseline',
      pricing: SCENARIO_PRICING,
      script: () => ({
        object: { paragraphs: ['An answer.', 'In two paragraphs.'] },
        usage: { inputTokens: 500, outputTokens: 300 },
      }),
    });
    // $0.01 at $5 per million output tokens buys 2,000 output tokens minus the prompt.
    const { fit, wordBudget, prompt } = sizeBaseline({
      model,
      problem,
      capUsd: 0.01,
      maxOutputTokens: 4_096,
    });
    expect(fit.fits && fit.shrunk).toBe(true);
    expect(fit.fits && fit.maxOutputTokens).toBeLessThan(2_000);
    expect(fit.fits && fit.maxOutputTokens).toBeGreaterThanOrEqual(MIN_OUTPUT_TOKENS);
    // The prompt states the budget as words derived from the allowance that fits.
    expect(wordBudget).toBe(wordBudgetFor(fit.fits ? fit.maxOutputTokens : 0));
    expect(wordBudget).toBeLessThan(fit.fits ? fit.maxOutputTokens : 0);
    expect(prompt).toContain(`you have about ${String(wordBudget)} words`);
    expect(prompt).toContain('Do the thing.');
    const generated = await generateBaseline(
      { model, problem, capUsd: 0.01, maxOutputTokens: 4_096 },
      tags,
      Date.UTC(2026, 10, 10),
    );
    expect(generated.ok).toBe(true);
    if (!generated.ok) return;
    expect(BaselineRecordSchema.safeParse(generated.value).success).toBe(true);
    expect(generated.value).toMatchObject({
      problemId: 'demo',
      modelId: 'fake-baseline',
      capUsd: 0.01,
      answer: 'An answer.\n\nIn two paragraphs.',
      passId: 'eval:p1',
      at: '2026-11-10T00:00:00.000Z',
    });
    expect(generated.value.maxOutputTokens).toBe(fit.fits ? fit.maxOutputTokens : -1);
    expect(generated.value.wordBudget).toBe(wordBudget);
    expect(generated.value.truncated).toBe(false);
    expect(model.calls[0]?.request.maxOutputTokens).toBe(generated.value.maxOutputTokens);
    expect(model.calls[0]?.request.prompt).toBe(prompt);
    expect(generated.value.usage.costUsd).toBeCloseTo(0.002, 6);
  });

  it('skips the call when even the floor does not fit, and a free model always fits', async () => {
    const paid = createFakeModel({ id: 'paid', pricing: SCENARIO_PRICING, script: [] });
    const refused = await generateBaseline(
      { model: paid, problem, capUsd: 0.0001, maxOutputTokens: 4_096 },
      tags,
      0,
    );
    expect(!refused.ok && refused.error.kind).toBe('does_not_fit');
    expect(!refused.ok && describeBaselineError(refused.error)).toContain('does not cover');
    expect(paid.calls.length).toBe(0);
    const free = createFakeModel({
      id: 'free',
      pricing: null,
      script: () => ({ object: { paragraphs: ['Free answer.'] } }),
    });
    const generated = await generateBaseline(
      { model: free, problem, capUsd: 0, maxOutputTokens: 1_024 },
      tags,
      0,
    );
    expect(generated.ok && generated.value.maxOutputTokens).toBe(1_024);
  });

  it('passes a model error through with a description', async () => {
    const broken = createFakeModel({
      id: 'broken',
      pricing: null,
      script: () => ({ object: { paragraphs: 42 } }),
    });
    const result = await generateBaseline(
      { model: broken, problem, capUsd: 1, maxOutputTokens: 1_024 },
      tags,
      0,
    );
    expect(!result.ok && result.error.kind).toBe('invalid_output');
    expect(!result.ok && describeBaselineError(result.error)).toContain('failed the schema');
    expect(describeBaselineError({ kind: 'script_exhausted', calls: 2 })).toContain('2 calls');
    expect(describeBaselineError({ kind: 'network', message: 'down', attempts: 3 })).toBe(
      'network: down',
    );
  });
});

describe('word budget and truncation', () => {
  it('derives a round word count from the allowance, never below the floor', () => {
    expect(wordBudgetFor(4_096)).toBe(2_600);
    expect(wordBudgetFor(1_700)).toBe(1_050);
    expect(wordBudgetFor(MIN_OUTPUT_TOKENS)).toBe(150);
    expect(wordBudgetFor(10)).toBe(100);
    expect(wordBudgetFor(1_000) % 50).toBe(0);
  });

  it('keeps an answer that used its whole allowance but marks it truncated', async () => {
    const model = createFakeModel({
      id: 'fake-baseline',
      pricing: null,
      script: () => ({
        object: { paragraphs: ['Cut off mid'] },
        usage: { inputTokens: 400, outputTokens: 1_024 },
      }),
    });
    const generated = await generateBaseline(
      { model, problem, capUsd: 0, maxOutputTokens: 1_024 },
      tags,
      0,
    );
    expect(generated.ok && generated.value.truncated).toBe(true);
    expect(generated.ok && generated.value.answer).toBe('Cut off mid');
    expect(hitAllowance(1_023, 1_024)).toBe(true);
    expect(hitAllowance(900, 1_024)).toBe(false);
  });

  it('reports an answer that ran into the allowance before closing its JSON as truncated', async () => {
    const model = createFakeModel({
      id: 'fake-baseline',
      pricing: null,
      script: () => ({
        error: {
          kind: 'invalid_output',
          issues: ['unexpected end of JSON input'],
          raw: '{"paragraphs": ["An answer that goes on and',
          usage: {
            inputTokens: 400,
            outputTokens: 512,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            costUsd: 0.004,
          },
        },
      }),
    });
    const result = await generateBaseline(
      { model, problem, capUsd: 1, maxOutputTokens: 512 },
      tags,
      0,
    );
    expect(!result.ok && result.error.kind).toBe('truncated');
    expect(!result.ok && describeBaselineError(result.error)).toBe(
      'truncated: the answer used its whole allowance of 512 output tokens and its JSON never closed',
    );
    expect(
      !result.ok && result.error.kind === 'truncated' && result.error.usage.usage.costUsd,
    ).toBe(0.004);
  });

  it('leaves the cache key alone when only the word budget changes', () => {
    expect(baselineCacheKey(problem, 'm1')).toBe(baselineCacheKey(problem, 'm1'));
    expect(baselinePrompt(problem, 300)).not.toBe(baselinePrompt(problem, 900));
  });
});
