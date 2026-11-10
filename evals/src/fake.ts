import { createFakeModel, type FakeModel, type ModelPricing } from '@team/core';
import { z } from 'zod';

// Stand-ins for the baseline and the judge under `--fake` (and in tests): deterministic,
// schema-driven, priced so the pass cap arithmetic is exercised, billed as `fake` so
// nothing reaches the month's ledger.

export const FAKE_BASELINE_USAGE = { inputTokens: 900, outputTokens: 450 };
export const FAKE_JUDGE_USAGE = { inputTokens: 2_600, outputTokens: 500 };

export const createFakeBaseline = (pricing: ModelPricing | null): FakeModel =>
  createFakeModel({
    id: 'fake-baseline',
    pricing,
    script: (request) => ({
      object: {
        paragraphs: [
          'Recommendation: adopt the smallest change that addresses the stated pain first, and measure it.',
          `Reasoning: the problem text (${String(request.prompt.length)} characters) names constraints that rule out the larger options; the modest option keeps them all.`,
          'Caveats: this is a scripted stand-in for a model answer, written so the harness can be exercised without spending anything.',
        ],
      },
      usage: FAKE_BASELINE_USAGE,
    }),
  });

const hash = (text: string): number => {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
};

const answersIn = (prompt: string): { A: string; B: string } => {
  const a = prompt.indexOf('# Answer A\n\n');
  const b = prompt.indexOf('# Answer B\n\n');
  if (a === -1 || b === -1) return { A: prompt, B: prompt };
  return { A: prompt.slice(a + 12, b).trim(), B: prompt.slice(b + 12).trim() };
};

const criteriaOf = (schema: z.ZodType): string[] => {
  const json = z.toJSONSchema(schema) as {
    properties?: { A?: { properties?: Record<string, unknown> } };
  };
  return Object.keys(json.properties?.A?.properties ?? {});
};

/**
 * Scores each answer from a hash of its own text and the criterion, so the same pair
 * judged in the other order gets the same scores: no position bias, perfect consistency.
 */
export const createFakeJudge = (pricing: ModelPricing | null): FakeModel =>
  createFakeModel({
    id: 'fake-judge',
    pricing,
    script: (request) => {
      const answers = answersIn(request.prompt);
      const criteria = criteriaOf(request.schema);
      const scoresFor = (text: string) =>
        Object.fromEntries(
          criteria.map((id) => [
            id,
            { score: 1 + (hash(`${id}:${text}`) % 3), reason: `Scripted score for ${id}.` },
          ]),
        );
      const A = scoresFor(answers.A);
      const B = scoresFor(answers.B);
      const total = (scores: Record<string, { score: number }>) =>
        Object.values(scores).reduce((sum, s) => sum + s.score, 0);
      return {
        object: {
          A,
          B,
          overall: total(A) > total(B) ? 'A' : total(B) > total(A) ? 'B' : 'tie',
          note: 'Scripted judgement.',
        },
        usage: FAKE_JUDGE_USAGE,
      };
    },
  });
