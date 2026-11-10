import { describe, expect, it } from 'vitest';

import type { UnblindedJudgement } from './judge';
import type { RubricCriterion } from './problems';
import { aggregate, scoreProblem, weightedPercent } from './scoring';

const rubric: RubricCriterion[] = [
  { id: 'a', weight: 3, criterion: 'A', scale: 's' },
  { id: 'b', weight: 1, criterion: 'B', scale: 's' },
];

const judgement = (
  swarm: [number, number],
  baseline: [number, number],
  order: UnblindedJudgement['order'],
  preferred: UnblindedJudgement['preferred'],
): UnblindedJudgement => ({
  order,
  swarm: { a: { score: swarm[0], reason: 'r' }, b: { score: swarm[1], reason: 'r' } },
  baseline: { a: { score: baseline[0], reason: 'r' }, b: { score: baseline[1], reason: 'r' } },
  preferred,
  note: '',
});

const SB = { A: 'swarm', B: 'baseline' } as const;
const BS = { A: 'baseline', B: 'swarm' } as const;

describe('weightedPercent', () => {
  it('weights criteria and normalises to the rubric maximum', () => {
    expect(
      weightedPercent(rubric, { a: { score: 3, reason: '' }, b: { score: 3, reason: '' } }),
    ).toBe(100);
    // 3×2 + 1×0 = 6 of 12.
    expect(
      weightedPercent(rubric, { a: { score: 2, reason: '' }, b: { score: 0, reason: '' } }),
    ).toBe(50);
    // A missing or out-of-range score counts as 0 or is clamped.
    expect(weightedPercent(rubric, { a: { score: 9, reason: '' } })).toBe(75);
    expect(weightedPercent([], {})).toBe(0);
  });
});

describe('scoreProblem', () => {
  it('averages the orders, takes the majority preference and measures the spread', () => {
    const scores = scoreProblem(rubric, [
      judgement([3, 3], [1, 1], SB, 'swarm'), // swarm 100, baseline 33.3
      judgement([2, 2], [1, 3], BS, 'swarm'), // swarm 66.7, baseline 50
    ]);
    expect(scores.swarm).toBeCloseTo(83.33, 1);
    expect(scores.baseline).toBeCloseTo(41.67, 1);
    expect(scores.delta).toBeCloseTo(41.67, 1);
    expect(scores.winner).toBe('swarm');
    // Spreads: swarm 33.3, baseline 16.7 → mean 25.
    expect(scores.consistency).toBeCloseTo(25, 1);
  });

  it('calls a split preference a tie and has no consistency with one order', () => {
    const scores = scoreProblem(rubric, [
      judgement([2, 2], [2, 2], SB, 'swarm'),
      judgement([2, 2], [2, 2], BS, 'baseline'),
    ]);
    expect(scores.winner).toBe('tie');
    expect(scoreProblem(rubric, [judgement([1, 1], [1, 1], SB, 'tie')]).consistency).toBeNull();
    expect(scoreProblem(rubric, [])).toEqual({
      swarm: null,
      baseline: null,
      delta: null,
      winner: null,
      consistency: null,
    });
  });
});

describe('aggregate', () => {
  it('counts judged pairs, wins and how often the first-shown answer won', () => {
    const results = [
      {
        scores: scoreProblem(rubric, [
          judgement([3, 3], [1, 1], SB, 'swarm'),
          judgement([3, 3], [1, 1], BS, 'swarm'),
        ]),
        judgements: [
          judgement([3, 3], [1, 1], SB, 'swarm'),
          judgement([3, 3], [1, 1], BS, 'swarm'),
        ],
      },
      {
        scores: scoreProblem(rubric, [
          judgement([1, 1], [3, 3], SB, 'baseline'),
          judgement([1, 1], [3, 3], BS, 'baseline'),
        ]),
        judgements: [
          judgement([1, 1], [3, 3], SB, 'baseline'),
          judgement([1, 1], [3, 3], BS, 'baseline'),
        ],
      },
      { scores: scoreProblem(rubric, []), judgements: [] },
    ];
    const a = aggregate(results);
    expect(a).toMatchObject({ problems: 3, judged: 2, wins: 1, losses: 1, ties: 0 });
    expect(a.swarmMean).toBeCloseTo(66.67, 1);
    expect(a.baselineMean).toBeCloseTo(66.67, 1);
    expect(a.meanDelta).toBeCloseTo(0, 5);
    // Each pair was preferred the same way in both orders, so the first-shown answer won
    // exactly half the time: no position bias.
    expect(a.firstShownPreferred).toEqual({ count: 2, of: 4 });
    expect(a.consistency).toBe(0);
  });
});
