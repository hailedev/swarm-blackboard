import { createFakeModel, MIN_OUTPUT_TOKENS } from '@team/core';
import { SCENARIO_PRICING } from '@team/core/testing';
import { describe, expect, it } from 'vitest';

import {
  baselineCacheKey,
  baselineIsShort,
  baselinePrompt,
  hitAllowance,
  salvageParagraphs,
  BaselineRecordSchema,
  describeBaselineError,
  generateBaseline,
  generateGuardedBaseline,
  sizeBaseline,
  wordBudgetFor,
} from './baseline';
import type { Problem } from './problems';
import { wordCount } from './words';

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
    expect(wordBudgetFor(4_096)).toBe(1_350);
    expect(wordBudgetFor(1_700)).toBe(550);
    expect(wordBudgetFor(MIN_OUTPUT_TOKENS)).toBe(100);
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
            reasoningTokens: 0,
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
      'truncated: the answer used its whole allowance of 512 output tokens and not one paragraph was finished',
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

describe('salvageParagraphs', () => {
  it('keeps every finished paragraph of an answer whose JSON never closed', () => {
    const raw =
      '{"paragraphs": ["First, with a \\"quoted\\" word.", "Second paragraph.", "Third that never en';
    expect(salvageParagraphs(raw)).toEqual(['First, with a "quoted" word.', 'Second paragraph.']);
    expect(salvageParagraphs('{"paragraphs": ["Only one unfinished')).toEqual([]);
    expect(salvageParagraphs('{"answer": "wrong shape"}')).toEqual([]);
    expect(salvageParagraphs('')).toEqual([]);
  });

  it('turns a truncated answer with finished paragraphs into a flagged record the pass can judge', async () => {
    const model = createFakeModel({
      id: 'fake-baseline',
      pricing: null,
      script: () => ({
        error: {
          kind: 'invalid_output',
          issues: ['unexpected end of JSON input'],
          raw: '{"paragraphs": ["A finished paragraph.", "And another one.", "Then the allowance ran ou',
          usage: {
            inputTokens: 400,
            outputTokens: 512,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            reasoningTokens: 0,
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
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({
      truncated: true,
      answer: 'A finished paragraph.\n\nAnd another one.',
      maxOutputTokens: 512,
    });
    expect(result.value.usage.costUsd).toBe(0.004);
  });
});

describe('generateGuardedBaseline: an answer under half its word budget', () => {
  // 2,048 output tokens buy 650 words: under 325 is short.
  const request = (script: readonly { words: number }[] | 'exhausted-after-one') => {
    const answers = script === 'exhausted-after-one' ? [{ words: 5 }] : script;
    const model = createFakeModel({
      id: 'fake-baseline',
      pricing: SCENARIO_PRICING,
      script: answers.map(({ words }) => ({
        object: {
          paragraphs: [Array.from({ length: words }, (_, i) => `w${String(i)}`).join(' ')],
        },
        usage: { inputTokens: 500, outputTokens: 300 },
      })),
    });
    return { model, request: { model, problem, capUsd: 0.08, maxOutputTokens: 2_048 } };
  };
  const callCost = 500 * 1e-6 + 300 * 5e-6;

  it('is left alone at half the budget or more', async () => {
    const { model, request: r } = request([{ words: 325 }]);
    const guarded = await generateGuardedBaseline(r, tags, () => 0);
    expect(guarded.ok && guarded.value.record).toMatchObject({
      attempts: 1,
      void: false,
      discardedCostUsd: 0,
      wordBudget: 650,
    });
    expect(guarded.ok && guarded.value.costUsd).toBeCloseTo(callCost, 10);
    expect(model.calls).toHaveLength(1);
  });

  it('is asked for once more with the same prompt, and the longer answer is kept', async () => {
    const { model, request: r } = request([{ words: 5 }, { words: 400 }]);
    const guarded = await generateGuardedBaseline(r, tags, () => 0);
    if (!guarded.ok) throw new Error('not generated');
    expect(guarded.value.record).toMatchObject({ attempts: 2, void: false });
    expect(wordCount(guarded.value.record.answer)).toBe(400);
    expect(guarded.value.record.discardedCostUsd).toBeCloseTo(callCost, 10);
    // The pass pays for both; the record's usage is the kept answer's own.
    expect(guarded.value.costUsd).toBeCloseTo(2 * callCost, 10);
    expect(guarded.value.record.usage.costUsd).toBeCloseTo(callCost, 10);
    expect(model.calls.map((call) => call.request.prompt)).toEqual([
      model.calls[0]?.request.prompt,
      model.calls[0]?.request.prompt,
    ]);
  });

  it('is void when the second is short too, keeping the longer of the two', async () => {
    const { request: r } = request([{ words: 120 }, { words: 60 }]);
    const guarded = await generateGuardedBaseline(r, tags, () => 0);
    if (!guarded.ok) throw new Error('not generated');
    expect(guarded.value.record).toMatchObject({ attempts: 2, void: true });
    expect(wordCount(guarded.value.record.answer)).toBe(120);
    expect(baselineIsShort(guarded.value.record)).toBe(true);
  });

  it('is void, with the first answer kept, when the second attempt fails', async () => {
    const { model, request: r } = request('exhausted-after-one');
    const guarded = await generateGuardedBaseline(r, tags, () => 0);
    if (!guarded.ok) throw new Error('not generated');
    expect(model.calls.map((call) => call.outcome)).toEqual(['ok', 'script_exhausted']);
    expect(guarded.value.record).toMatchObject({ attempts: 2, void: true, discardedCostUsd: 0 });
    expect(guarded.value.costUsd).toBeCloseTo(callCost, 10);
  });

  it('reads a record written before the guard as one attempt, not void', () => {
    const old = {
      key: 'k',
      problemId: 'demo',
      modelId: 'm',
      capUsd: 0.03,
      maxOutputTokens: 2_700,
      wordBudget: 900,
      truncated: false,
      answer: 'An old answer.',
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        costUsd: 0,
      },
      latencyMs: 1,
      at: '2026-11-16T00:00:00.000Z',
      passId: 'p',
    };
    expect(BaselineRecordSchema.parse(old)).toMatchObject({
      attempts: 1,
      void: false,
      discardedCostUsd: 0,
    });
  });
});
