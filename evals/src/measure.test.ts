import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createFakeModel, err, ok, zeroUsage, type Model, type Result } from '@team/core';
import { SCENARIO_PRICING } from '@team/core/testing';
import { afterEach, describe, expect, it } from 'vitest';

import type { EvalIo } from './cli';
import { createFakeBaseline, createFakeJudge, FAKE_BASELINE_USAGE, FAKE_JUDGE_USAGE } from './fake';
import {
  answerKeys,
  runGenerate,
  runScore,
  scoreKeys,
  sizeAnswers,
  sizeProblems,
  type GenerateDeps,
  type GenerateOptions,
  type ScoreOptions,
  type SwarmArm,
} from './measure';
import { comparisonsOf, findMeasurementDir, MEASURE_USAGE, measureMain } from './measure-cli';
import {
  answerId,
  answerSlug,
  armRef,
  armSlug,
  fileMeasureStore,
  memoryMeasureStore,
  parseArm,
  scoreSlug,
  type Arm,
  type MeasuredAnswer,
} from './measure-store';
import type { SwarmOutcome } from './pass';
import type { Problem } from './problems';

const problem = (id: string): Problem => ({
  id,
  title: `Problem ${id}`,
  domain: 'test',
  constraints: ['keep it short'],
  successCriteria: ['answers the question'],
  rubric: [
    { id: 'coverage', weight: 3, criterion: 'Covers the question', scale: '0 = no; 3 = fully' },
    { id: 'clarity', weight: 1, criterion: 'Is clear', scale: '0 = no; 3 = fully' },
  ],
  statement: `Statement of ${id}.`,
});

const CALL: Arm = { kind: 'call', alias: 'strong' };
const FREE: Arm = { kind: 'call', alias: 'local' };
const SWARM: Arm = { kind: 'swarm', profile: 'cheap' };

const BASELINE_COST =
  (FAKE_BASELINE_USAGE.inputTokens * 1 + FAKE_BASELINE_USAGE.outputTokens * 5) / 1e6;
const JUDGE_COST = (FAKE_JUDGE_USAGE.inputTokens * 1 + FAKE_JUDGE_USAGE.outputTokens * 5) / 1e6;
const RUN_COST = 0.02;

const words = (count: number): string =>
  Array.from({ length: count }, (_, i) => `w${String(i + 1)}`).join(' ');

/** What a swarm run came to, as the runner reports it. */
const outcome = (overrides: Partial<SwarmOutcome> = {}): SwarmOutcome => ({
  runId: 'run-1',
  answer: words(700),
  confidence: 0.7,
  stage: 'final',
  writeUp: {
    maxOutputTokens: 2_700,
    wordBudget: 900,
    written: true,
    costUsd: 0.002,
    attempts: 1,
    short: false,
    retriedFor: [],
    leaks: [],
  },
  writeUpFailure: null,
  loop: {
    critiques: {
      raised: 5,
      resolved: 2,
      replaced: 1,
      open: { blocking: 0, major: 1, minor: 1 },
      namedStillOpen: 0,
    },
    calls: { made: 20, rejected: 0 },
    trimmedReplies: 0,
    decisions: 0,
    drafts: 3,
    subproblems: { open: 0, claimed: 1, done: 2 },
    rejectedHypotheses: 0,
    rivals: 0,
    claimsWithoutSuperseding: 0,
    subproblemsWithSecondAnswer: 0,
  },
  rounds: 12,
  status: 'completed',
  reason: 'budget_rounds',
  entries: 60,
  usage: { ...zeroUsage(), costUsd: RUN_COST },
  costUsd: RUN_COST,
  elapsedMs: 240_000,
  ...overrides,
});

const setup = () => {
  const store = memoryMeasureStore();
  const lines: string[] = [];
  const strong = createFakeBaseline(SCENARIO_PRICING);
  const local = createFakeBaseline(null);
  const swarmRuns: { problemId: string; maxCostUsd: number; allowance: number | null }[] = [];
  // What the next runs of the swarm come to, by problem; the default is a full answer.
  const script = new Map<string, Result<SwarmOutcome, string>[]>();
  const swarm: SwarmArm = {
    paid: true,
    run: (p, maxCostUsd, allowance) => {
      swarmRuns.push({ problemId: p.id, maxCostUsd, allowance });
      const next = script.get(p.id)?.shift();
      return Promise.resolve(next ?? ok(outcome({ runId: `run-${String(swarmRuns.length)}` })));
    },
  };
  const models = new Map<string, Model>([
    ['strong', strong],
    ['local', local],
  ]);
  const deps: GenerateDeps = {
    store,
    sizingModel: strong,
    callModel: (alias) => {
      const model = models.get(alias);
      return model === undefined ? err(`unknown alias ${alias}`) : ok(model);
    },
    swarm: (profile) =>
      Promise.resolve(
        profile === 'cheap' ? ok(swarm) : err(`cannot reach the model of ${profile}`),
      ),
    month: null,
    commit: 'abc1234',
    now: () => Date.parse('2026-11-17T00:00:00Z'),
    log: (line) => lines.push(line),
  };
  const options = (overrides: Partial<GenerateOptions> = {}): GenerateOptions => ({
    sessionId: 's1',
    problems: [problem('one'), problem('two')],
    arms: [CALL, SWARM, FREE],
    runs: 2,
    capUsd: 1,
    runCapUsd: 0.08,
    wordBudget: 900,
    maxOutputTokens: 2_700,
    ...overrides,
  });
  return { store, lines, strong, local, swarm, swarmRuns, script, models, deps, options };
};

const generated = async (s: ReturnType<typeof setup>, overrides: Partial<GenerateOptions> = {}) => {
  const result = await runGenerate(s.options(overrides), s.deps);
  if (!result.ok) throw new Error(result.error.join('; '));
  return result.value;
};

describe('arms, answers and scores by name', () => {
  it('parses an arm and names its files', () => {
    expect(parseArm('call:sonnet')).toEqual(ok({ kind: 'call', alias: 'sonnet' }));
    expect(parseArm('swarm:cheap')).toEqual(ok({ kind: 'swarm', profile: 'cheap' }));
    for (const bad of ['sonnet', 'call:', 'baseline:sonnet', 'swarm:a:b']) {
      expect(parseArm(bad).ok, bad).toBe(false);
    }
    expect(armRef(SWARM)).toBe('swarm:cheap');
    expect(armSlug({ kind: 'call', alias: 'local-fast' })).toBe('call-local-fast');
    expect(answerSlug({ problemId: 'one', arm: CALL, run: 1 })).toBe('call-strong');
    expect(answerSlug({ problemId: 'one', arm: SWARM, run: 3 })).toBe('swarm-cheap--r3');
    expect(answerId({ problemId: 'one', arm: SWARM, run: 3 })).toBe('one/swarm-cheap--r3');
    expect(scoreSlug({ problemId: 'one', arm: SWARM, run: 3, score: 2 })).toBe(
      'swarm-cheap--r3--s2',
    );
  });

  it('orders the answers arm by arm, and a swarm arm run by run', () => {
    expect(answerKeys(['one', 'two'], [CALL, SWARM, FREE], 2).map(answerId)).toEqual([
      'one/call-strong',
      'two/call-strong',
      'one/swarm-cheap--r1',
      'two/swarm-cheap--r1',
      'one/swarm-cheap--r2',
      'two/swarm-cheap--r2',
      'one/call-local',
      'two/call-local',
    ]);
  });

  it('orders the scores sweep by sweep, and a sweep problem by problem', () => {
    expect(
      scoreKeys(['one', 'two'], [CALL, SWARM], 2, 2).map(
        (key) => `${answerId(key)}#${String(key.score)}`,
      ),
    ).toEqual([
      'one/call-strong#1',
      'one/swarm-cheap--r1#1',
      'one/swarm-cheap--r2#1',
      'two/call-strong#1',
      'two/swarm-cheap--r1#1',
      'two/swarm-cheap--r2#1',
      'one/call-strong#2',
      'one/swarm-cheap--r1#2',
      'one/swarm-cheap--r2#2',
      'two/call-strong#2',
      'two/swarm-cheap--r1#2',
      'two/swarm-cheap--r2#2',
    ]);
  });
});

describe('sizing every arm to one length', () => {
  it('gives every problem the allowance the sizing model fits under the run cap', () => {
    const { strong } = setup();
    const sizes = sizeAnswers([problem('one')], strong, 0.08, 2_700);
    expect(sizes).toEqual([{ problemId: 'one', maxOutputTokens: 2_700, wordBudget: 900 }]);
    expect(sizeProblems(sizes, 900)).toEqual([]);
  });

  it('names a problem a smaller cap would ask for fewer words, or nothing', () => {
    const { strong } = setup();
    const shrunk = sizeAnswers([problem('one')], strong, 0.006, 2_700);
    expect(shrunk[0]?.maxOutputTokens).toBeLessThan(2_700);
    expect(shrunk[0]?.wordBudget).toBeLessThan(900);
    expect(sizeProblems(shrunk, 900)).toEqual([
      `one: the run cap buys ${String(shrunk[0]?.maxOutputTokens)} output tokens, about ${String(shrunk[0]?.wordBudget)} words, not 900`,
    ]);
    const none = sizeAnswers([problem('one')], strong, 0.0001, 2_700);
    expect(sizeProblems(none, 900)).toEqual(['one: no answer fits the run cap']);
  });
});

describe('stage 1: the answers', () => {
  it('makes every answer in order, each asked for the same words, and records what it cost', async () => {
    const s = setup();
    const tally = await generated(s);
    expect(tally).toMatchObject({ items: 8, onDisk: 0, done: 8, failed: 0, notRun: 0 });
    expect(tally.stopped).toBeNull();
    expect(tally.spentUsd).toBeCloseTo(2 * BASELINE_COST + 4 * RUN_COST, 10);
    expect(tally.stageSpentUsd).toBeCloseTo(tally.spentUsd, 10);

    const answers = await s.store.listAnswers();
    expect(answers).toHaveLength(8);
    for (const answer of answers) {
      expect(answer).toMatchObject({ outcome: 'answered', wordBudget: 900, tries: 1 });
      expect(answer.commit).toBe('abc1234');
    }
    // The call arms were asked with the baseline's own prompt and the same sentence.
    for (const model of [s.strong, s.local]) {
      expect(model.calls).toHaveLength(2);
      expect(model.calls[0]?.request.prompt).toContain('you have about 900 words');
      expect(model.calls[0]?.request.maxOutputTokens).toBe(2_700);
      expect(model.calls[0]?.request.tags).toEqual({
        role: 'eval-baseline',
        runId: 'eval:s1',
        round: 0,
      });
    }
    // The swarm got the same allowance for its write-up, and its whole cap, run by run.
    expect(s.swarmRuns).toEqual([
      { problemId: 'one', maxCostUsd: 0.08, allowance: 2_700 },
      { problemId: 'two', maxCostUsd: 0.08, allowance: 2_700 },
      { problemId: 'one', maxCostUsd: 0.08, allowance: 2_700 },
      { problemId: 'two', maxCostUsd: 0.08, allowance: 2_700 },
    ]);
    const call = await s.store.readAnswer({ problemId: 'one', arm: CALL, run: 1 });
    expect(call).toMatchObject({
      spentUsd: BASELINE_COST,
      detail: { kind: 'call', modelId: 'fake-baseline', attempts: 1, truncated: false },
    });
    const run = await s.store.readAnswer({ problemId: 'two', arm: SWARM, run: 2 });
    expect(run).toMatchObject({
      words: 700,
      spentUsd: RUN_COST,
      detail: {
        kind: 'swarm',
        rounds: 12,
        reason: 'budget_rounds',
        stage: 'final',
        critiques: { raised: 5, resolved: 2 },
        calls: { made: 20, rejected: 0 },
      },
    });
    const free = await s.store.readAnswer({ problemId: 'one', arm: FREE, run: 1 });
    expect(free).toMatchObject({ outcome: 'answered', spentUsd: 0 });
  });

  it('leaves alone what is on disk and makes only what is missing', async () => {
    const s = setup();
    await generated(s, { problems: [problem('one')] });
    const callsBefore = s.strong.calls.length;
    const runsBefore = s.swarmRuns.length;
    const tally = await generated(s);
    expect(tally).toMatchObject({ items: 8, onDisk: 4, done: 4, failed: 0 });
    expect(s.strong.calls.length - callsBefore).toBe(1);
    expect(s.swarmRuns.slice(runsBefore).map((r) => r.problemId)).toEqual(['two', 'two']);
    // And a third time there is nothing to do, and nothing is spent.
    const again = await generated(s);
    expect(again).toMatchObject({ onDisk: 8, done: 0, spentUsd: 0 });
    expect(again.stageSpentUsd).toBeCloseTo(2 * BASELINE_COST + 4 * RUN_COST, 10);
  });

  it('tries a failed answer again next time, carrying what the failure cost', async () => {
    const s = setup();
    // The local model went away during the first run on `one`; the run had spent a cent.
    s.script.set('one', [
      ok(outcome({ status: 'paused', reason: 'provider_unreachable', rounds: 5, costUsd: 0.01 })),
    ]);
    const first = await generated(s, { arms: [SWARM], runs: 1 });
    expect(first).toMatchObject({ done: 1, failed: 1 });
    const failed = await s.store.readAnswer({ problemId: 'one', arm: SWARM, run: 1 });
    expect(failed).toEqual({
      problemId: 'one',
      arm: SWARM,
      run: 1,
      commit: 'abc1234',
      at: '2026-11-17T00:00:00.000Z',
      tries: 1,
      spentUsd: 0.01,
      outcome: 'failed',
      why: 'the run ended paused/provider_unreachable after 5 rounds',
    });
    expect(s.lines.join('\n')).toContain('one/swarm-cheap--r1: FAILED');

    const second = await generated(s, { arms: [SWARM], runs: 1 });
    expect(second).toMatchObject({ onDisk: 1, done: 1, failed: 0 });
    expect(second.spentUsd).toBeCloseTo(RUN_COST, 10);
    expect(second.stageSpentUsd).toBeCloseTo(0.01 + 2 * RUN_COST, 10);
    const mended = await s.store.readAnswer({ problemId: 'one', arm: SWARM, run: 1 });
    expect(mended).toMatchObject({ outcome: 'answered', tries: 2 });
    expect(mended?.spentUsd).toBeCloseTo(0.01 + RUN_COST, 10);
  });

  it('keeps one cap over the stage, however many invocations it takes', async () => {
    const s = setup();
    // Room for the two calls and one run of the four: 2 × 0.0032 + 0.02 leaves under 0.08.
    const cap = 0.1;
    const first = await generated(s, { capUsd: cap });
    expect(first).toMatchObject({ done: 5, notRun: 3 });
    expect(s.swarmRuns).toHaveLength(1);
    expect(s.lines.join('\n')).toContain('a run needs its whole cap');
    // The free arm was not held up by a cap it cannot spend.
    expect(await s.store.readAnswer({ problemId: 'two', arm: FREE, run: 1 })).toMatchObject({
      outcome: 'answered',
    });
    // A second invocation under the same cap starts from what the first spent.
    const second = await generated(s, { capUsd: cap });
    expect(second).toMatchObject({ onDisk: 5, done: 0, notRun: 3, spentUsd: 0 });
    expect(second.stageSpentUsd).toBeCloseTo(first.stageSpentUsd, 10);
    expect(s.swarmRuns).toHaveLength(1);
    // A larger cap finishes the stage.
    const third = await generated(s, { capUsd: 1 });
    expect(third).toMatchObject({ onDisk: 5, done: 3, notRun: 0 });
  });

  it('makes a paid call only at its whole allowance', async () => {
    const s = setup();
    // The stage has less left than one full-length call costs at worst.
    const tally = await generated(s, { arms: [CALL], capUsd: 0.005 });
    expect(tally).toMatchObject({ done: 0, notRun: 2, spentUsd: 0 });
    expect(s.strong.calls).toEqual([]);
    expect(await s.store.listAnswers()).toEqual([]);
  });

  it('marks as void an answer that is none, or under half its words after its retry', async () => {
    const s = setup();
    const terse = createFakeModel({
      id: 'fake-terse',
      pricing: SCENARIO_PRICING,
      script: () => ({
        object: { paragraphs: ['Do the small thing.'] },
        usage: FAKE_BASELINE_USAGE,
      }),
    });
    s.models.set('strong', terse);
    s.script.set('one', [
      ok(outcome({ answer: null, stage: null, writeUp: null, reason: 'stalled', rounds: 3 })),
    ]);
    s.script.set('two', [
      ok(
        outcome({
          answer: words(200),
          writeUp: {
            maxOutputTokens: 2_700,
            wordBudget: 900,
            written: true,
            costUsd: 0.004,
            attempts: 2,
            short: true,
            retriedFor: ['short'],
            leaks: [],
          },
        }),
      ),
    ]);
    const tally = await generated(s, { arms: [CALL, SWARM], runs: 1 });
    expect(tally).toMatchObject({ done: 4, failed: 0 });
    // The call was made twice and is still short: both calls are paid for.
    expect(terse.calls).toHaveLength(4);
    const call = await s.store.readAnswer({ problemId: 'one', arm: CALL, run: 1 });
    expect(call).toMatchObject({
      outcome: 'void',
      why: '4 words of about 900 asked for, after a second attempt',
      words: 4,
      wordBudget: 900,
    });
    expect(call?.spentUsd).toBeCloseTo(2 * BASELINE_COST, 10);
    expect(await s.store.readAnswer({ problemId: 'one', arm: SWARM, run: 1 })).toMatchObject({
      outcome: 'void',
      why: 'no synthesis: completed/stalled after 3 rounds',
      text: null,
      words: 0,
    });
    expect(await s.store.readAnswer({ problemId: 'two', arm: SWARM, run: 1 })).toMatchObject({
      outcome: 'void',
      why: '200 words of about 900 asked for, after a second attempt',
      words: 200,
    });
    // A void answer is an outcome: it is not made again.
    const again = await generated(s, { arms: [CALL, SWARM], runs: 1 });
    expect(again).toMatchObject({ onDisk: 4, done: 0 });
  });

  it('keeps a draft that stands in for a failed write-up, and what the write-up still says', async () => {
    const s = setup();
    s.script.set('one', [
      ok(
        outcome({
          answer: words(150),
          stage: 'draft',
          writeUpFailure: 'invalid_output: cites.0: Invalid option',
        }),
      ),
    ]);
    s.script.set('two', [
      ok(
        outcome({
          writeUp: {
            maxOutputTokens: 2_700,
            wordBudget: 900,
            written: true,
            costUsd: 0.004,
            attempts: 2,
            short: false,
            retriedFor: ['leak'],
            leaks: ['Confidence is moderate.'],
          },
        }),
      ),
    ]);
    await generated(s, { arms: [SWARM], runs: 1 });
    expect(await s.store.readAnswer({ problemId: 'one', arm: SWARM, run: 1 })).toMatchObject({
      outcome: 'answered',
      words: 150,
      detail: { stage: 'draft', writeUpFailure: 'invalid_output: cites.0: Invalid option' },
    });
    expect(await s.store.readAnswer({ problemId: 'two', arm: SWARM, run: 1 })).toMatchObject({
      outcome: 'answered',
      detail: { writeUp: { retriedFor: ['leak'], leaks: ['Confidence is moderate.'] } },
    });
    const log = s.lines.join('\n');
    expect(log).toContain('a DRAFT (invalid_output: cites.0: Invalid option)');
    expect(log).toContain('write-up asked again for leak, 1 sentence(s) still LEAK');
  });

  it('records a call that failed, and a swarm that could not be built or started', async () => {
    const s = setup();
    s.models.set(
      'strong',
      createFakeModel({
        pricing: SCENARIO_PRICING,
        script: () => ({ error: { kind: 'network', message: 'connection reset', attempts: 3 } }),
      }),
    );
    s.script.set('one', [err('could not start: invalid_config: the cap is too small')]);
    const tally = await generated(s, {
      problems: [problem('one')],
      arms: [CALL, SWARM, { kind: 'swarm', profile: 'dev' }],
      runs: 1,
    });
    expect(tally).toMatchObject({ done: 0, failed: 3, spentUsd: 0 });
    const whys = (await s.store.listAnswers()).map((a) => (a.outcome === 'failed' ? a.why : ''));
    expect(whys).toEqual([
      'network: connection reset',
      'could not start: invalid_config: the cap is too small',
      'cannot reach the model of dev',
    ]);
  });

  it('makes no further paid call once the provider refuses, and goes on with the free arm', async () => {
    const s = setup();
    s.models.set(
      'strong',
      createFakeModel({
        pricing: SCENARIO_PRICING,
        script: () => ({ error: { kind: 'billing', message: 'credit balance too low' } }),
      }),
    );
    const tally = await generated(s);
    expect(tally.stopped).toBe('billing');
    // One refused call; the second call and every run are not attempted; the free arm runs.
    expect(tally).toMatchObject({ failed: 1, notRun: 5, done: 2 });
    expect(s.swarmRuns).toEqual([]);
    expect(s.local.calls).toHaveLength(2);
  });

  it('stops paid work when the month is spent', async () => {
    const s = setup();
    let spent = 4.99;
    s.deps.month = { spentUsd: () => Promise.resolve(spent), limitUsd: 5 };
    s.swarm.run = (p) => {
      spent = 5.01;
      return Promise.resolve(ok(outcome({ runId: `run-${p.id}` })));
    };
    const tally = await generated(s, { arms: [SWARM, FREE], runs: 2 });
    expect(tally).toMatchObject({ done: 3, notRun: 3 });
    expect(tally.stopped).toBe('monthly_budget: $5.0100 of $5.00 spent');
  });

  it('refuses, before anything is spent, a problem that would be asked for another length', async () => {
    const s = setup();
    const refused = await runGenerate(s.options({ runCapUsd: 0.006 }), s.deps);
    expect(refused.ok).toBe(false);
    expect(!refused.ok && refused.error).toHaveLength(2);
    expect(!refused.ok && refused.error[0]).toMatch(/^one: the run cap buys \d+ output tokens/);
    expect(s.strong.calls).toEqual([]);
    expect(s.swarmRuns).toEqual([]);
    expect(await s.store.listAnswers()).toEqual([]);
  });
});

describe('stage 2: the scores', () => {
  const scoring = async (overrides: Partial<ScoreOptions> = {}, judge?: Model) => {
    const s = setup();
    s.script.set('two', [ok(outcome({ answer: null, stage: null, writeUp: null }))]);
    await generated(s, { arms: [CALL, SWARM], runs: 1 });
    const judgeModel = judge ?? createFakeJudge(SCENARIO_PRICING);
    const lines: string[] = [];
    const options: ScoreOptions = {
      sessionId: 's2',
      problems: [problem('one'), problem('two')],
      arms: [CALL, SWARM],
      runs: 1,
      scores: 2,
      capUsd: 1,
      judgeMaxOutputTokens: 1_024,
      ...overrides,
    };
    const deps = {
      store: s.store,
      judgeModel,
      month: null,
      now: () => Date.parse('2026-11-17T01:00:00Z'),
      log: (line: string) => lines.push(line),
    };
    return { ...s, judgeModel, lines, options, deps };
  };

  it('scores every answered answer alone, the first scores before the second', async () => {
    const s = await scoring();
    const tally = await runScore(s.options, s.deps);
    // Three answers were answered (the swarm's run on `two` is void): six scores.
    expect(tally).toMatchObject({ items: 6, done: 6, onDisk: 0, failed: 0, notRun: 0 });
    expect(tally.spentUsd).toBeCloseTo(6 * JUDGE_COST, 10);
    const scores = await s.store.listScores();
    expect(scores).toHaveLength(6);
    expect(s.lines.map((line) => line.trim().split(':')[0])).toEqual([
      'one/call-strong score 1',
      'one/swarm-cheap--r1 score 1',
      'two/call-strong score 1',
      'one/call-strong score 2',
      'one/swarm-cheap--r1 score 2',
      'two/call-strong score 2',
    ]);
    const one = await s.store.readScore({ problemId: 'one', arm: SWARM, run: 1, score: 2 });
    expect(one).toMatchObject({
      outcome: 'scored',
      judgeModelId: 'fake-judge',
      spentUsd: JUDGE_COST,
      tries: 1,
    });
    expect(one?.outcome === 'scored' && Object.keys(one.scores)).toEqual(['coverage', 'clarity']);
    expect(one?.outcome === 'scored' && one.percent).toBeGreaterThan(0);
    // The judge saw one answer and nothing beside it, tagged as a solo judgement.
    const judge = s.judgeModel as ReturnType<typeof createFakeJudge>;
    expect(judge.calls[0]?.request.prompt).toContain('# Answer\n\n');
    expect(judge.calls[0]?.request.prompt).not.toContain('# Answer A');
    expect(judge.calls[0]?.request.tags.role).toBe('eval-judge-solo');
    expect(await s.store.readScore({ problemId: 'two', arm: SWARM, run: 1, score: 1 })).toBe(
      undefined,
    );
  });

  it('gives a score once: a second invocation has nothing to do', async () => {
    const s = await scoring();
    await runScore(s.options, s.deps);
    const again = await runScore(s.options, s.deps);
    expect(again).toMatchObject({ items: 6, onDisk: 6, done: 0, spentUsd: 0 });
    expect(again.stageSpentUsd).toBeCloseTo(6 * JUDGE_COST, 10);
  });

  it('stops at the stage cap with the second scores, not an arm, outstanding', async () => {
    const s = await scoring({ capUsd: 4 * JUDGE_COST + 0.004 });
    const tally = await runScore(s.options, s.deps);
    expect(tally).toMatchObject({ done: 4, notRun: 2 });
    expect(tally.stopped).toMatch(/^stage cap: \$0\.00\d+ left does not cover the judge call/);
    const done = (await s.store.listScores()).map((r) => `${answerId(r)}#${String(r.score)}`);
    expect(done.sort()).toEqual([
      'one/call-strong#1',
      'one/call-strong#2',
      'one/swarm-cheap--r1#1',
      'two/call-strong#1',
    ]);
    // With a larger cap the stage finishes from where it stopped.
    const rest = await runScore({ ...s.options, capUsd: 1 }, s.deps);
    expect(rest).toMatchObject({ onDisk: 4, done: 2, notRun: 0 });
    expect(rest.stageSpentUsd).toBeCloseTo(6 * JUDGE_COST, 10);
  });

  it('records a failed score and gives it again next time', async () => {
    const real = createFakeJudge(SCENARIO_PRICING);
    let calls = 0;
    const flaky: Model = {
      ...real,
      generateObject: (request) => {
        calls += 1;
        return calls === 1
          ? Promise.resolve(err({ kind: 'overloaded', message: 'try later', attempts: 3 }))
          : real.generateObject(request);
      },
    };
    const s = await scoring({}, flaky);
    const first = await runScore(s.options, s.deps);
    expect(first).toMatchObject({ done: 5, failed: 1 });
    const key = { problemId: 'one', arm: CALL, run: 1, score: 1 };
    expect(await s.store.readScore(key)).toMatchObject({ outcome: 'failed', why: 'overloaded' });
    const second = await runScore(s.options, s.deps);
    expect(second).toMatchObject({ items: 6, onDisk: 5, done: 1, failed: 0 });
    expect(await s.store.readScore(key)).toMatchObject({ outcome: 'scored', tries: 2 });
  });
});

// ── The command ──────────────────────────────────────────────────────────────────────────

const ROSTER = fileURLToPath(new URL('../../agents.yaml', import.meta.url));
const PROBLEMS = fileURLToPath(new URL('../problems', import.meta.url));

const capture = () => {
  const lines: string[] = [];
  const io: EvalIo = { write: (line) => lines.push(line) };
  return { lines, io, text: () => lines.join('\n') };
};

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
const tempDir = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'swarm-measure-'));
  tempDirs.push(dir);
  return dir;
};

const ARMS = 'call:sonnet,call:haiku,swarm:cheap,swarm:dev,call:local-fast';
const args = (stage: string, out: string, ...rest: string[]): string[] => [
  stage,
  '--fake',
  '--roster',
  ROSTER,
  '--problems-dir',
  PROBLEMS,
  '--db',
  ':memory:',
  '--out',
  out,
  '--label',
  'trial',
  ...rest,
];
const clockAt = (iso: string) => ({ nowMs: () => Date.parse(iso) });

describe('pnpm eval:measure --fake', () => {
  it('generates, resumes, scores and reports in one folder, whatever the date', async () => {
    const out = await tempDir();
    const first = capture();
    const generate = args(
      'generate',
      out,
      '--arms',
      ARMS,
      '--profile',
      'cheap',
      '--runs',
      '2',
      '--problems',
      'api-rate-limiting,oidc-migration',
    );
    expect(
      await measureMain(generate, first.io, {}, clockAt('2026-11-17T09:00:00Z')),
      first.text(),
    ).toBe(0);
    expect(first.text()).toContain('== Measurement "trial": generate ==');
    expect(first.text()).toContain('answer length about 900 words');
    expect(first.text()).toContain(
      'to make       call:sonnet 2 of 2; call:haiku 2 of 2; swarm:cheap 4 of 4; swarm:dev 4 of 4; call:local-fast 2 of 2',
    );
    expect(first.text()).toContain(
      'Stage 1: 14 answers made, 0 already on disk, 0 failed, 0 not run',
    );
    expect(first.text()).toContain('14 of 70 answers made; 0 void, 0 failed, 56 not yet made.');
    expect(await readdir(out)).toEqual(['2026-11-17-trial']);
    const dir = join(out, '2026-11-17-trial');
    expect(await findMeasurementDir(out, 'trial')).toBe(dir);
    expect((await readdir(join(dir, 'answers', 'oidc-migration'))).sort()).toEqual([
      'call-haiku.json',
      'call-local-fast.json',
      'call-sonnet.json',
      'swarm-cheap--r1.json',
      'swarm-cheap--r2.json',
      'swarm-dev--r1.json',
      'swarm-dev--r2.json',
    ]);
    const manifest = await fileMeasureStore(dir).readManifest();
    expect(manifest).toMatchObject({
      label: 'trial',
      profile: 'cheap',
      runs: 2,
      scoresPerAnswer: 2,
      wordBudget: 900,
      fake: true,
      comparisons: [
        { swarm: { kind: 'swarm', profile: 'cheap' }, call: { kind: 'call', alias: 'haiku' } },
        { swarm: { kind: 'swarm', profile: 'dev' }, call: { kind: 'call', alias: 'local-fast' } },
      ],
    });
    expect(manifest?.problemIds).toHaveLength(10);

    // The next day, with no arms given: the same folder, and nothing is made twice.
    const second = capture();
    expect(
      await measureMain(
        args('generate', out, '--problems', 'api-rate-limiting,oidc-migration'),
        second.io,
        {},
        clockAt('2026-11-18T09:00:00Z'),
      ),
      second.text(),
    ).toBe(0);
    expect(second.text()).toContain('Stage 1: 0 answers made, 14 already on disk');
    expect(await readdir(out)).toEqual(['2026-11-17-trial']);

    // Scoring, then the report alone.
    const scored = capture();
    expect(
      await measureMain(args('score', out), scored.io, {}, clockAt('2026-11-18T10:00:00Z')),
      scored.text(),
    ).toBe(0);
    expect(scored.text()).toContain('to give       28 scores; 0 already on disk');
    expect(scored.text()).toContain(
      'Stage 2: 28 scores made, 0 already on disk, 0 failed, 0 not run',
    );
    const report = capture();
    expect(await measureMain(args('report', out), report.io)).toBe(0);
    const markdown = await readFile(join(dir, 'report.md'), 'utf8');
    for (const heading of [
      '# Measurement: trial',
      '## Stage 1: the answers',
      '## Stage 2: the scores',
      '28 of 28 scores given',
      '## Per arm',
      '## Answers at 100 %',
      '## Run to run',
      '## The judge against itself',
      '## Every arm, per problem',
      '## `swarm:cheap` against `call:haiku`',
      '## `swarm:dev` against `call:local-fast`',
      '## Limits',
      'Scripted models (`--fake`)',
    ]) {
      expect(markdown, heading).toContain(heading);
    }
    const json = JSON.parse(await readFile(join(dir, 'report.json'), 'utf8')) as {
      summary: { answers: { answered: number }; scores: { scored: number } };
    };
    expect(json.summary.answers.answered).toBe(14);
    expect(json.summary.scores.scored).toBe(28);
    expect((await readdir(join(dir, 'spot-check'))).length).toBeGreaterThan(0);
  });

  it('says what a stage would do and spends nothing on a dry run', async () => {
    const out = await tempDir();
    const { io, text } = capture();
    expect(await measureMain(args('generate', out, '--arms', ARMS, '--dry-run'), io), text()).toBe(
      0,
    );
    expect(text()).toContain(
      'to make       call:sonnet 10 of 10; call:haiku 10 of 10; swarm:cheap 30 of 30',
    );
    expect(text()).toContain('Dry run: nothing made, nothing spent.');
    // Not even the folder: the measurement does not exist until something is made.
    expect(await readdir(out)).toEqual([]);
  });

  it('holds a measurement to what it was made with', async () => {
    const out = await tempDir();
    const made = capture();
    expect(
      await measureMain(
        args('generate', out, '--arms', 'call:sonnet', '--problems', 'oidc-migration'),
        made.io,
      ),
      made.text(),
    ).toBe(0);
    for (const [change, message] of [
      [['--arms', 'call:haiku'], 'they cannot be changed'],
      [['--runs', '5'], 'runs per swarm arm; that cannot be changed'],
      [['--profile', 'quality'], 'that cannot be changed'],
      [['--run-cap', '0.5'], 'has a run cap of $0.1000; that cannot be changed'],
    ] as const) {
      const { io, text } = capture();
      expect(await measureMain(args('generate', out, ...change), io), text()).toBe(2);
      expect(text()).toContain(message);
    }
    // Without --fake it is another measurement's business.
    const real = capture();
    expect(
      await measureMain(
        args('generate', out).filter((arg) => arg !== '--fake'),
        real.io,
      ),
    ).toBe(2);
    expect(real.text()).toContain('was made with --fake');
  });

  it('refuses what it cannot make sense of', async () => {
    const out = await tempDir();
    const cases: [string[], string][] = [
      [['--label', 'x'], 'say what to do: generate, score or report'],
      [['generate', '--fake', '--out', out], '--label is required'],
      [args('score', out), 'no measurement labelled "trial"'],
      [args('report', out), 'no measurement labelled "trial"'],
      [args('generate', out), 'a new measurement needs --arms'],
      [args('generate', out, '--arms', 'sonnet'), 'is not call:<alias> or swarm:<profile>'],
      [args('generate', out, '--arms', 'call:sonnet,call:sonnet'), 'names call:sonnet twice'],
      [args('generate', out, '--arms', 'call:gpt'), 'unknown model alias "gpt"'],
      [args('generate', out, '--arms', 'swarm:nope'), 'nope'],
      [args('generate', out, '--arms', 'call:sonnet', '--problems', 'nope'), 'unknown problem id'],
      [args('generate', out, '--arms', 'call:sonnet', '--runs', '0'), 'must be at least 1'],
      [args('generate', out, '--arms', 'call:sonnet', '--max-cost', 'lots'), '--max-cost must be'],
      [['generate', '--bogus'], 'bogus'],
    ];
    for (const [argv, message] of cases) {
      const { io, text } = capture();
      expect(await measureMain(argv, io), argv.join(' ')).toBe(2);
      expect(text(), argv.join(' ')).toContain(message);
    }
    const help = capture();
    expect(await measureMain(['--help'], help.io)).toBe(0);
    expect(help.lines).toEqual(MEASURE_USAGE);
  });
});

describe('comparisonsOf', () => {
  it('pairs a swarm arm with the call on its Synthesizer’s model, when there is one', async () => {
    const { loadRosterFile } = await import('@team/host');
    const roster = await loadRosterFile(ROSTER);
    if (!roster.ok) throw new Error(roster.error);
    const arms = ['call:sonnet', 'call:haiku', 'swarm:cheap', 'swarm:quality', 'swarm:dev'].map(
      (text) => {
        const arm = parseArm(text);
        if (!arm.ok) throw new Error(arm.error);
        return arm.value;
      },
    );
    const pairs = comparisonsOf(roster.value, arms);
    expect(pairs.ok && pairs.value.map((p) => `${armRef(p.swarm)}=${armRef(p.call)}`)).toEqual([
      'swarm:cheap=call:haiku',
      'swarm:quality=call:sonnet',
      // dev's Synthesizer is local-fast, and no call arm of this measurement is.
    ]);
  });
});

// A record as stage 1 leaves it, for the store's own round trip.
describe('fileMeasureStore', () => {
  it('reads back what it wrote, and treats a damaged file as absent', async () => {
    const dir = await tempDir();
    const store = fileMeasureStore(dir);
    expect(await store.readManifest()).toBeUndefined();
    expect(await store.listAnswers()).toEqual([]);
    const answer: MeasuredAnswer = {
      problemId: 'one',
      arm: SWARM,
      run: 2,
      at: '2026-11-17T00:00:00.000Z',
      commit: null,
      spentUsd: 0.01,
      tries: 1,
      outcome: 'failed',
      why: 'the run ended paused/provider_unreachable after 5 rounds',
    };
    await store.writeAnswer(answer);
    expect(await store.readAnswer(answer)).toEqual(answer);
    expect(await store.listAnswers()).toEqual([answer]);
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(dir, 'answers', 'one', 'swarm-cheap--r2.json'), '{"problemId": "one", ');
    expect(await store.readAnswer(answer)).toBeUndefined();
    expect(await store.listAnswers()).toEqual([]);
  });
});
