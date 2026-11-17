import { createFakeModel, type FakeModel, type ModelPricing } from '@team/core';
import { z } from 'zod';

// Stand-ins for the baseline and the judge under `--fake` (and in tests): deterministic,
// schema-driven, priced so the pass cap arithmetic is exercised, billed as `fake` so
// nothing reaches the month's ledger.

export const FAKE_BASELINE_USAGE = { inputTokens: 900, outputTokens: 450 };
export const FAKE_JUDGE_USAGE = { inputTokens: 2_600, outputTokens: 500 };

/** The words the prompt's length instruction asks for (core, `lengthInstruction`); 0 when it names none. */
const wordsAskedFor = (prompt: string): number => {
  const match = /you have about (\d+) words/.exec(prompt);
  return match?.[1] === undefined ? 0 : Number(match[1]);
};

const STEP =
  'the change is made behind a switch, measured for a week against the figure agreed beforehand, and kept only if that figure moved; if it did not, the switch goes back and the reason is written down before anything else is tried.';

/**
 * A scripted answer of about three fifths of the words it was asked for: over the half
 * under which a baseline is asked for again and then void (baseline.ts), so a scripted
 * pass exercises the ordinary path. The steps repeat; it is a stand-in, not an answer.
 */
export const createFakeBaseline = (pricing: ModelPricing | null): FakeModel =>
  createFakeModel({
    id: 'fake-baseline',
    pricing,
    script: (request) => {
      const paragraphs = [
        'Recommendation: adopt the smallest change that addresses the stated pain first, and measure it.',
        `Reasoning: the problem text (${String(request.prompt.length)} characters) names constraints that rule out the larger options; the modest option keeps them all.`,
        'Caveats: this is a scripted stand-in for a model answer, written so the harness can be exercised without spending anything.',
      ];
      const count = (): number => paragraphs.join(' ').split(/\s+/).length;
      const target = Math.ceil(wordsAskedFor(request.prompt) * 0.6);
      for (let step = 1; count() < target; step += 1) {
        paragraphs.push(`Step ${String(step)}: ${STEP}`);
      }
      return { object: { paragraphs }, usage: FAKE_BASELINE_USAGE };
    },
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

/** The answer of a solo prompt (judge.ts, `soloJudgePrompt`): everything after "# Answer". */
const soloAnswerIn = (prompt: string): string => {
  const at = prompt.indexOf('# Answer\n\n');
  return at === -1 ? prompt : prompt.slice(at + 10).trim();
};

type JudgeSchemaShape = {
  properties?: {
    A?: { properties?: Record<string, unknown> };
    scores?: { properties?: Record<string, unknown> };
  };
};

/** The rubric's criterion ids, and whether the schema is the solo one (one answer, `scores`). */
const criteriaOf = (schema: z.ZodType): { ids: string[]; solo: boolean } => {
  const json = z.toJSONSchema(schema) as JudgeSchemaShape;
  const solo = json.properties?.scores?.properties;
  return solo === undefined
    ? { ids: Object.keys(json.properties?.A?.properties ?? {}), solo: false }
    : { ids: Object.keys(solo), solo: true };
};

/**
 * Scores each answer from a hash of its own text and the criterion, so the same pair
 * judged in the other order gets the same scores: no position bias, perfect consistency.
 * Answers the solo schema too (one answer, no comparison).
 */
export const createFakeJudge = (pricing: ModelPricing | null): FakeModel =>
  createFakeModel({
    id: 'fake-judge',
    pricing,
    script: (request) => {
      const answers = answersIn(request.prompt);
      const { ids: criteria, solo } = criteriaOf(request.schema);
      const scoresFor = (text: string) =>
        Object.fromEntries(
          criteria.map((id) => [
            id,
            { score: 1 + (hash(`${id}:${text}`) % 3), reason: `Scripted score for ${id}.` },
          ]),
        );
      // One answer alone: the same score its text gets in a pair, so the scripted judge
      // is as indifferent to company as it is to order.
      if (solo) {
        return {
          object: {
            scores: scoresFor(soloAnswerIn(request.prompt)),
            note: 'Scripted solo judgement.',
          },
          usage: FAKE_JUDGE_USAGE,
        };
      }
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
