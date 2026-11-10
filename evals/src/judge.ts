import { z } from 'zod';

import { MAX_SCORE, problemText, type Problem } from './problems';

// The judge scores both answers against the rubric in one call, blind to which arm wrote
// which (ADR-0012). The two answers are shown as "Answer A" and "Answer B" in an order
// drawn from a seeded generator; a pass judges each pair in both orders so position bias
// cancels in the mean and shows up as a measured number.

export type Arm = 'swarm' | 'baseline';
export const ARMS: readonly Arm[] = ['swarm', 'baseline'];
export type Slot = 'A' | 'B';
export type Preference = Slot | 'tie';

export interface BlindOrder {
  A: Arm;
  B: Arm;
}

export const JUDGE_SYSTEM = [
  'You are grading two answers to the same problem against a rubric. You do not know who',
  'or what wrote either answer, and you must not guess. For every rubric criterion, score',
  'each answer independently on the 0 to 3 scale using the anchors given, and give a',
  'one-sentence reason that points at something specific in that answer. Do not reward',
  'length, confidence or formatting; reward correctness, specificity and respect for the',
  "problem's constraints and success criteria. Finally say which answer is better overall,",
  'or that they tie, in one sentence. Return only JSON matching the schema.',
].join(' ');

export interface CriterionScore {
  score: number;
  reason: string;
}

export interface Judgement {
  A: Record<string, CriterionScore>;
  B: Record<string, CriterionScore>;
  overall: Preference;
  note: string;
}

/** The judge's per-call schema: one score object per rubric criterion, for each answer. */
export const judgementSchema = (problem: Problem): z.ZodType<Judgement> => {
  const score = z.object({ score: z.int().min(0).max(MAX_SCORE), reason: z.string().min(1) });
  const perAnswer = z.object(Object.fromEntries(problem.rubric.map((c) => [c.id, score])));
  return z.object({
    A: perAnswer,
    B: perAnswer,
    overall: z.enum(['A', 'B', 'tie']),
    note: z.string(),
  });
};

export const judgePrompt = (problem: Problem, answers: Record<Slot, string>): string =>
  [
    '# Problem',
    problemText(problem),
    '# Rubric',
    'Score each criterion from 0 to 3 using these anchors.',
    ...problem.rubric.map((c) => `- ${c.id}: ${c.criterion}\n  Scale: ${c.scale}`),
    '# Answer A',
    answers.A,
    '# Answer B',
    answers.B,
  ].join('\n\n');

/** A small seeded generator, so a pass's blind orders are reproducible from its seed. */
export const mulberry32 = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

export const blindOrder = (rng: () => number): BlindOrder =>
  rng() < 0.5 ? { A: 'swarm', B: 'baseline' } : { A: 'baseline', B: 'swarm' };

export const swapped = (order: BlindOrder): BlindOrder => ({ A: order.B, B: order.A });

export interface UnblindedJudgement {
  order: BlindOrder;
  swarm: Record<string, CriterionScore>;
  baseline: Record<string, CriterionScore>;
  preferred: Arm | 'tie';
  note: string;
}

export const unblind = (judgement: Judgement, order: BlindOrder): UnblindedJudgement => {
  const slotOf = (arm: Arm): Slot => (order.A === arm ? 'A' : 'B');
  return {
    order,
    swarm: judgement[slotOf('swarm')],
    baseline: judgement[slotOf('baseline')],
    preferred: judgement.overall === 'tie' ? 'tie' : order[judgement.overall],
    note: judgement.note,
  };
};
