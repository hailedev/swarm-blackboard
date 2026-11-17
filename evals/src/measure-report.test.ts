import { zeroUsage } from '@team/core';
import { describe, expect, it } from 'vitest';

import {
  DEVELOPMENT_SET,
  mean,
  median,
  renderMeasureReport,
  sampleSd,
  spotChecks,
  spreadOf,
  summarise,
} from './measure-report';
import type { Arm, Manifest, MeasuredAnswer, ScoreRecord } from './measure-store';
import type { Problem } from './problems';

const CALL: Arm = { kind: 'call', alias: 'haiku' };
const SWARM: Arm = { kind: 'swarm', profile: 'cheap' };
// One problem of the development set and two that are not.
const PROBLEMS = ['api-rate-limiting', 'beta', 'gamma'];

const manifest = (overrides: Partial<Manifest> = {}): Manifest => ({
  label: 'closing',
  createdAt: '2026-11-17T00:00:00.000Z',
  commit: 'abc1234',
  profile: 'cheap',
  arms: [CALL, SWARM],
  runs: 3,
  scoresPerAnswer: 2,
  problemIds: PROBLEMS,
  wordBudget: 900,
  runCapUsd: 0.03,
  comparisons: [{ swarm: SWARM, call: CALL }],
  models: { 'call:haiku': 'one call of `haiku`', 'swarm:cheap': 'the `cheap` swarm' },
  caps: { generateUsd: 1.2, scoreUsd: 2.8 },
  fake: false,
  ...overrides,
});

const base = (problemId: string, arm: Arm, run: number) => ({
  problemId,
  arm,
  run,
  at: '2026-11-17T00:00:00.000Z',
  commit: 'abc1234',
  tries: 1,
});

const called = (problemId: string, wordCount = 800): MeasuredAnswer => ({
  ...base(problemId, CALL, 1),
  outcome: 'answered',
  spentUsd: 0.001,
  text: `The call's answer on ${problemId}.`,
  words: wordCount,
  wordBudget: 900,
  detail: {
    kind: 'call',
    modelId: 'claude-haiku-5-5',
    maxOutputTokens: 2_694,
    usage: zeroUsage(),
    latencyMs: 9_000,
    attempts: 1,
    truncated: false,
  },
});

const swarmDetail = (overrides: Record<string, unknown> = {}) => ({
  kind: 'swarm' as const,
  runId: 'run',
  rounds: 12,
  status: 'completed' as const,
  reason: 'budget_rounds' as const,
  entries: 60,
  elapsedMs: 300_000,
  usage: zeroUsage(),
  confidence: 0.6,
  stage: 'final' as const,
  writeUp: {
    maxOutputTokens: 2_694,
    wordBudget: 900,
    written: true,
    costUsd: 0.002,
    attempts: 1,
    short: false,
    retriedFor: [] as ('short' | 'leak')[],
    leaks: [] as string[],
  },
  writeUpFailure: null as string | null,
  critiques: { raised: 20, resolved: 8 },
  calls: { made: 24, rejected: 0 },
  ...overrides,
});

const ran = (
  problemId: string,
  run: number,
  detail: Record<string, unknown> = {},
  wordCount = 700,
): MeasuredAnswer => ({
  ...base(problemId, SWARM, run),
  outcome: 'answered',
  spentUsd: 0.018,
  text: `The swarm's answer on ${problemId}, run ${String(run)}.`,
  words: wordCount,
  wordBudget: 900,
  detail: swarmDetail(detail),
});

const score = (
  problemId: string,
  arm: Arm,
  run: number,
  index: number,
  percent: number,
): ScoreRecord => ({
  problemId,
  arm,
  run,
  score: index,
  at: '2026-11-17T02:00:00.000Z',
  judgeModelId: 'claude-sonnet-5-5',
  spentUsd: 0.014,
  tries: 1,
  outcome: 'scored',
  percent,
  scores: { coverage: { reason: `Reason ${String(index)}.`, score: 2 } },
  note: `Note ${String(index)}.`,
  usage: zeroUsage(),
});

/** Both scores of an answer. */
const scored = (problemId: string, arm: Arm, run: number, first: number, second: number) => [
  score(problemId, arm, run, 1, first),
  score(problemId, arm, run, 2, second),
];

// The fixture, with every figure worked by hand in the tests below.
//
//                     call      swarm run 1   run 2     run 3
//   api-rate-limiting 80, 90    70, 70        80, 90    100, 100
//   beta              60, 60    90, 80        70, 70    void
//   gamma             100, 100  failed        missing   50, 70
const answers = (): MeasuredAnswer[] => [
  called('api-rate-limiting'),
  called('beta'),
  called('gamma', 1_000),
  ran('api-rate-limiting', 1),
  ran('api-rate-limiting', 2, {
    writeUp: { ...swarmDetail().writeUp, attempts: 2, retriedFor: ['leak'] },
  }),
  ran('api-rate-limiting', 3, {
    writeUp: {
      ...swarmDetail().writeUp,
      attempts: 2,
      retriedFor: ['short', 'leak'],
      leaks: ['Confidence is moderate.'],
    },
  }),
  ran('beta', 1, { reason: 'completed', rounds: 7, elapsedMs: 180_000 }),
  ran('beta', 2, { stage: 'draft', writeUpFailure: 'invalid_output: cites.0' }, 160),
  {
    ...base('beta', SWARM, 3),
    outcome: 'void',
    spentUsd: 0.02,
    why: '200 words of about 900 asked for, after a second attempt',
    text: 'Too short.',
    words: 200,
    wordBudget: 900,
    detail: swarmDetail({
      writeUp: { ...swarmDetail().writeUp, attempts: 2, short: true, retriedFor: ['short'] },
    }),
  },
  {
    ...base('gamma', SWARM, 1),
    tries: 2,
    outcome: 'failed',
    spentUsd: 0.005,
    why: 'the run ended paused/provider_unreachable after 4 rounds',
  },
  { ...ran('gamma', 3), tries: 2, commit: 'def5678' },
];

const scores = (): ScoreRecord[] => [
  ...scored('api-rate-limiting', CALL, 1, 80, 90),
  ...scored('beta', CALL, 1, 60, 60),
  ...scored('gamma', CALL, 1, 100, 100),
  ...scored('api-rate-limiting', SWARM, 1, 70, 70),
  ...scored('api-rate-limiting', SWARM, 2, 80, 90),
  ...scored('api-rate-limiting', SWARM, 3, 100, 100),
  ...scored('beta', SWARM, 1, 90, 80),
  ...scored('beta', SWARM, 2, 70, 70),
  score('gamma', SWARM, 3, 1, 50),
  {
    problemId: 'gamma',
    arm: SWARM,
    run: 3,
    score: 2,
    at: '2026-11-17T02:00:00.000Z',
    judgeModelId: 'claude-sonnet-5-5',
    spentUsd: 0.014,
    tries: 1,
    outcome: 'failed',
    why: 'overloaded',
  },
];

describe('the arithmetic', () => {
  it('means, medians and the sample standard deviation', () => {
    expect(mean([])).toBeNull();
    expect(mean([70, 85, 100])).toBe(85);
    expect(median([])).toBeNull();
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(sampleSd([5])).toBeNull();
    expect(sampleSd([70, 85, 100])).toBe(15);
    expect(sampleSd([85, 75])).toBeCloseTo(7.0711, 4);
    expect(spreadOf([70, 85, 100])).toEqual({ n: 3, mean: 85, sd: 15, min: 70, max: 100 });
    expect(spreadOf([])).toEqual({ n: 0, mean: null, sd: null, min: null, max: null });
  });

  it('knows the development set', () => {
    expect(DEVELOPMENT_SET).toEqual([
      'api-rate-limiting',
      'oidc-migration',
      'teen-reading-programme',
    ]);
  });
});

describe('summarise', () => {
  const summary = summarise(manifest(), answers(), scores());
  const [call, swarm] = summary.arms;

  it('counts what stage 1 made, per arm and in all', () => {
    expect(summary.answers).toEqual({ expected: 12, answered: 9, void: 1, failed: 1, missing: 1 });
    expect(call?.counts).toMatchObject({
      expected: 3,
      answered: 3,
      void: 0,
      failed: 0,
      missing: 0,
      words: { min: 800, median: 800, max: 1_000 },
    });
    expect(call?.counts.spentUsd).toBeCloseTo(0.003, 10);
    expect(swarm?.counts).toMatchObject({
      expected: 9,
      answered: 6,
      void: 1,
      failed: 1,
      missing: 1,
      words: { min: 160, median: 700, max: 700 },
    });
    // Six answered at $0.018, the void one at $0.02, the failed one at $0.005.
    expect(swarm?.counts.spentUsd).toBeCloseTo(6 * 0.018 + 0.02 + 0.005, 10);
    expect(summary.spent.generateUsd).toBeCloseTo(0.003 + 0.133, 10);
    expect(call?.swarm).toBeNull();
    expect(swarm?.swarm).toEqual({
      // The void run ended too; the failed one never did.
      endings: { budget_rounds: 6, completed: 1 },
      rounds: { min: 7, max: 12 },
      final: 5,
      drafts: 1,
      retriedShort: 2,
      retriedLeak: 2,
      leaking: 1,
      meanMinutes: (6 * 5 + 3) / 7,
    });
  });

  it('lists what a reader has to know about before trusting a mean', () => {
    expect(summary.voids).toEqual([
      {
        id: 'beta/swarm-cheap--r3',
        note: '200 words of about 900 asked for, after a second attempt',
      },
    ]);
    expect(summary.failures).toEqual([
      {
        id: 'gamma/swarm-cheap--r1',
        note: 'the run ended paused/provider_unreachable after 4 rounds (2 tries)',
      },
    ]);
    expect(summary.drafts).toEqual([
      { id: 'beta/swarm-cheap--r2', note: 'invalid_output: cites.0' },
    ]);
    expect(summary.leaking).toEqual([
      { id: 'api-rate-limiting/swarm-cheap--r3', sentences: ['Confidence is moderate.'] },
    ]);
    expect(summary.retried).toEqual([{ id: 'gamma/swarm-cheap--r3', note: '2 tries' }]);
    expect(summary.scoreFailures).toEqual([
      { id: 'gamma/swarm-cheap--r3 score 2', note: 'overloaded' },
    ]);
    expect(summary.truncated).toEqual([]);
    expect(summary.offBudget).toEqual([]);
    expect(summary.commits).toEqual(['abc1234', 'def5678']);
    // Nine answered answers, two scores each; one failed, none missing.
    expect(summary.scores).toEqual({ expected: 18, scored: 17, failed: 1, missing: 0 });
    expect(summary.spent.scoreUsd).toBeCloseTo(18 * 0.014, 10);
  });

  it('scores an answer by the mean of its scores and an arm by the mean over its answers', () => {
    expect(call?.cells.map((c) => c.mean)).toEqual([85, 60, 100]);
    expect(swarm?.cells[0]).toMatchObject({
      problemId: 'api-rate-limiting',
      answers: [
        { run: 1, scores: [70, 70], mean: 70 },
        { run: 2, scores: [80, 90], mean: 85 },
        { run: 3, scores: [100, 100], mean: 100 },
      ],
      mean: 85,
      min: 70,
      max: 100,
      sd: 15,
      range: 30,
    });
    // The void run has no score: beta is the mean of two runs, 85 and 70.
    expect(swarm?.cells[1]).toMatchObject({ mean: 77.5, min: 70, max: 85, range: 15 });
    expect(swarm?.cells[1]?.sd).toBeCloseTo(15 / Math.SQRT2, 10);
    // One run with one score: it is the cell, and there is no spread to speak of.
    expect(swarm?.cells[2]).toMatchObject({
      answers: [{ run: 3, scores: [50], mean: 50 }],
      mean: 50,
      sd: null,
      range: null,
    });
  });

  it('gives each arm a mean and a spread over problems, and the two sets apart', () => {
    expect(call?.overProblems.n).toBe(3);
    expect(call?.overProblems.mean).toBeCloseTo(81.6667, 4);
    expect(call?.overProblems.sd).toBeCloseTo(20.2073, 4);
    expect(call?.overProblems).toMatchObject({ min: 60, max: 100 });
    // The swarm's three problems: 85, 77.5 and 50.
    expect(swarm?.overProblems.mean).toBeCloseTo(212.5 / 3, 10);
    expect(swarm?.overProblems.sd).toBeCloseTo(18.4278, 4);
    expect(call?.development).toMatchObject({ n: 1, mean: 85 });
    expect(call?.heldOut).toMatchObject({ n: 2, mean: 80 });
    expect(swarm?.development).toMatchObject({ n: 1, mean: 85 });
    expect(swarm?.heldOut).toMatchObject({ n: 2, mean: 63.75 });
  });

  it('measures the swarm against itself from run to run', () => {
    expect(call?.runToRun).toBeNull();
    // Two problems have two or more runs: variances 225 and 112.5, ranges 30 and 15.
    expect(swarm?.runToRun?.problems).toBe(2);
    expect(swarm?.runToRun?.pooledSd).toBeCloseTo(Math.sqrt(168.75), 10);
    expect(swarm?.runToRun?.meanRange).toBe(22.5);
    expect(swarm?.runToRun?.largest).toEqual({ problemId: 'api-rate-limiting', range: 30 });
  });

  it('measures the judge against itself, and counts the answers at the ceiling', () => {
    // Call: |80−90|, |60−60|, |100−100|.
    expect(call?.judge).toEqual({ answers: 3, meanSpread: 10 / 3, largest: 10 });
    // Swarm: 0, 10, 0, 10, 0 over the five answers scored twice.
    expect(swarm?.judge).toEqual({ answers: 5, meanSpread: 4, largest: 10 });
    expect(summary.judge).toEqual({ answers: 8, meanSpread: 30 / 8, largest: 10 });
    expect(call?.ceiling).toEqual({
      answersAt100: 1,
      answersScored: 3,
      scoresAt100: 2,
      scores: 6,
    });
    expect(swarm?.ceiling).toEqual({
      answersAt100: 1,
      answersScored: 6,
      scoresAt100: 2,
      scores: 11,
    });
  });

  it('sets the swarm beside the call, problem by problem', () => {
    const [comparison] = summary.comparisons;
    expect(comparison?.rows).toEqual([
      {
        problemId: 'api-rate-limiting',
        callScores: [80, 90],
        call: 85,
        runs: [
          { run: 1, score: 70 },
          { run: 2, score: 85 },
          { run: 3, score: 100 },
        ],
        swarm: 85,
        delta: 0,
        runsAbove: 1,
      },
      {
        problemId: 'beta',
        callScores: [60, 60],
        call: 60,
        runs: [
          { run: 1, score: 85 },
          { run: 2, score: 70 },
        ],
        swarm: 77.5,
        delta: 17.5,
        runsAbove: 2,
      },
      {
        problemId: 'gamma',
        callScores: [100, 100],
        call: 100,
        runs: [{ run: 3, score: 50 }],
        swarm: 50,
        delta: -50,
        runsAbove: 0,
      },
    ]);
    // Deltas 0, +17.5 and −50: mean −32.5 / 3. Their squares sum to 2,806.25, less
    // 3 × mean² leaves 2,454.1667; over n − 1 that is a variance of 1,227.0833.
    expect(comparison).toMatchObject({
      n: 3,
      ahead: 1,
      behind: 1,
      level: 1,
      runsAbove: 3,
      runsScored: 6,
    });
    expect(comparison?.meanDelta).toBeCloseTo(-32.5 / 3, 10);
    expect(comparison?.sdDelta).toBeCloseTo(35.0297, 4);
    expect(comparison?.seDelta).toBeCloseTo(35.0297 / Math.sqrt(3), 4);
  });

  it('leaves out a comparison whose arms the measurement does not have', () => {
    const other = summarise(
      manifest({ comparisons: [{ swarm: { kind: 'swarm', profile: 'dev' }, call: CALL }] }),
      answers(),
      scores(),
    );
    expect(other.comparisons).toEqual([]);
  });
});

describe('renderMeasureReport', () => {
  it('is the account of stage 1 while nothing is scored', () => {
    const m = manifest();
    const text = renderMeasureReport(m, summarise(m, answers(), []));
    expect(text).toContain('# Measurement: closing');
    expect(text).toContain('9 of 12 answers made; 1 void, 1 failed, 1 not yet made.');
    expect(text).toContain('| `call:haiku` | 3 | 3 | 0 | 0 | 0 | $0.0030 | 800 / 800 / 1000 |');
    expect(text).toContain(
      '| `swarm:cheap` | budget_rounds × 6, completed × 1 | 7 to 12 | 5 | 1 | 2 | 2 | 1 | 4.7 |',
    );
    expect(text).toContain(
      '- `beta/swarm-cheap--r3`: 200 words of about 900 asked for, after a second attempt',
    );
    expect(text).toContain('- `gamma/swarm-cheap--r1`: the run ended paused/provider_unreachable');
    expect(text).toContain('- `beta/swarm-cheap--r2`: invalid_output: cites.0');
    expect(text).toContain('  - "Confidence is moderate."');
    expect(text).toContain('**the answers were made on more than one commit**');
    expect(text).toContain('0 of 18 scores given');
    expect(text).toContain('No answer has been scored yet');
    expect(text).not.toContain('## Per arm');
  });

  it('shows every figure Hai asked for once the scores are in', () => {
    const m = manifest();
    const text = renderMeasureReport(m, summarise(m, answers(), scores()));
    expect(text).toContain('17 of 18 scores given');
    expect(text).toContain('- `gamma/swarm-cheap--r3 score 2`: overloaded');
    // Per arm: mean, spread over problems, the two sets.
    expect(text).toContain(
      '| `call:haiku` | **81.7** | 20.2 | 60.0 to 100.0 | 3 | 85.0 (n 1) | 80.0 (n 2) |',
    );
    expect(text).toContain(
      '| `swarm:cheap` | **70.8** | 18.4 | 50.0 to 85.0 | 3 | 85.0 (n 1) | 63.8 (n 2) |',
    );
    // At 100 %.
    expect(text).toContain('| `swarm:cheap` | 1 of 6 | 2 of 11 |');
    // Run to run.
    expect(text).toContain('| `swarm:cheap` | 2 | 13.0 | 22.5 | 30.0 (api-rate-limiting) |');
    expect(text).toContain('| beta | 85.0 / 70.0 (10.6, 15.0) |');
    expect(text).toContain('| api-rate-limiting | 70.0 / 85.0 / 100.0 (15.0, 30.0) |');
    expect(text).toContain('| gamma | 50.0 (—, —) |');
    // The judge against itself.
    expect(text).toContain('| `swarm:cheap` | 5 | 4.0 | 10.0 |');
    expect(text).toContain('| **All** | 8 | 3.8 | 10.0 |');
    // Side by side.
    expect(text).toContain('| api-rate-limiting (dev) | 85.0 | 85.0 (70.0 to 100.0) |');
    expect(text).toContain('| gamma | 100.0 | 50.0 |');
    expect(text).toContain('| beta | 60.0 | 77.5 (70.0 to 85.0) |');
    expect(text).toContain('| **Mean** | **81.7** | **70.8** |');
    // The comparison.
    expect(text).toContain('## `swarm:cheap` against `call:haiku`');
    expect(text).toContain(
      '| beta | 60.0 (60.0, 60.0) | 85.0 | 70.0 | — | 77.5 | +17.5 | 2 of 2 |',
    );
    expect(text).toContain(
      '| gamma | 100.0 (100.0, 100.0) | — | — | 50.0 | 50.0 | -50.0 | 0 of 1 |',
    );
    expect(text).toContain(
      'Over 3 problems: mean Δ **-10.8** points (SD 35.0, standard error 20.2); the swarm is ahead on 1, behind on 1, level on 1; 3 of 6 single runs scored above the call. For scale: the swarm’s run-to-run pooled SD is 13.0 points, and the judge’s mean difference between its two scores is 4.0 on the swarm’s answers and 3.3 on the call’s.',
    );
    expect(text).toContain('## Limits');
  });
});

describe('spotChecks', () => {
  const problems: Problem[] = PROBLEMS.map((id) => ({
    id,
    title: id,
    domain: 'test',
    constraints: [],
    successCriteria: [],
    rubric: [
      { id: 'coverage', weight: 3, criterion: 'Covers', scale: '0 to 3' },
      { id: 'clarity', weight: 1, criterion: 'Clear', scale: '0 to 3' },
      { id: 'limits', weight: 1, criterion: 'Limits', scale: '0 to 3' },
    ],
    statement: `Statement of ${id}.`,
  }));

  it('writes out the widest lead each way and the closest, with the judge’s reasons', () => {
    const m = manifest();
    const checks = spotChecks(m, summarise(m, answers(), scores()), problems, answers(), scores());
    expect(checks.map((c) => [c.problemId, c.why])).toEqual([
      ['beta', 'the swarm’s widest lead'],
      ['gamma', 'the call’s widest lead'],
      ['api-rate-limiting', 'the closest'],
    ]);
    const closest = checks[2]?.markdown ?? '';
    expect(closest).toContain('# api-rate-limiting: the closest');
    expect(closest).toContain('`swarm:cheap` 85.0 against `call:haiku` 85.0 (Δ +0.0)');
    expect(closest).toContain('Statement of api-rate-limiting.');
    expect(closest).toContain("The call's answer on api-rate-limiting.");
    // Of runs at 70, 85 and 100, the median one stands for the swarm.
    expect(closest).toContain('## `swarm:cheap`, run 2 (its median run)');
    expect(closest).toContain("The swarm's answer on api-rate-limiting, run 2.");
    expect(closest).toContain('**Score 1: 80.0 %.** Note 1.');
    expect(closest).toContain('- coverage: 2 of 3. Reason 2.');
  });

  it('has nothing to show before anything is scored, or with nothing to compare', () => {
    const m = manifest();
    expect(spotChecks(m, summarise(m, answers(), []), problems, answers(), [])).toEqual([]);
    const alone = manifest({ comparisons: [] });
    expect(
      spotChecks(alone, summarise(alone, answers(), scores()), problems, answers(), scores()),
    ).toEqual([]);
  });
});
