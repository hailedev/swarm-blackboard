import { createFakeModel, err, ok, zeroUsage } from '@team/core';
import { SCENARIO_PRICING } from '@team/core/testing';
import { describe, expect, it } from 'vitest';

import { sizeBaseline, type BaselineCache, type BaselineRecord } from './baseline';
import { createFakeBaseline, createFakeJudge, FAKE_BASELINE_USAGE, FAKE_JUDGE_USAGE } from './fake';
import { mulberry32 } from './judge';
import { PassBudget, runPass, type PassDeps, type PassOptions, type SwarmOutcome } from './pass';
import type { Problem } from './problems';
import { lowSwarmScores, renderPair, renderReport, selectPairs, wordCount } from './report';

const problem = (id: string): Problem => ({
  id,
  title: `Problem ${id}`,
  domain: 'test',
  constraints: ['keep it short'],
  successCriteria: ['answers the question'],
  rubric: [
    { id: 'coverage', weight: 3, criterion: 'Covers the question', scale: '0 = no; 3 = fully' },
    { id: 'clarity', weight: 1, criterion: 'Is clear', scale: '0 = no; 3 = fully' },
    { id: 'honesty', weight: 2, criterion: 'Names its limits', scale: '0 = no; 3 = fully' },
  ],
  statement: `Statement of ${id}.`,
});

const memoryCache = (): BaselineCache & { records: Map<string, BaselineRecord> } => {
  const records = new Map<string, BaselineRecord>();
  return {
    records,
    get: (id, modelId) => Promise.resolve(records.get(`${id}|${modelId}`)),
    put: (record) => {
      records.set(`${record.problemId}|${record.modelId}`, record);
      return Promise.resolve();
    },
  };
};

// A run that ended with its final write-up, unless it has no answer or `overrides` say otherwise.
const swarmOutcome = (
  id: string,
  costUsd: number,
  answer: string | null = `Swarm answer for ${id}.`,
  overrides: Partial<SwarmOutcome> = {},
): SwarmOutcome => ({
  runId: `run-${id}`,
  answer,
  confidence: answer === null ? null : 0.9,
  stage: answer === null ? null : 'final',
  writeUp:
    answer === null
      ? null
      : {
          maxOutputTokens: 2_048,
          wordBudget: 650,
          written: true,
          costUsd: 0.004,
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
      namedStillOpen: 1,
    },
    calls: { made: 8, rejected: 1 },
    trimmedReplies: 2,
    decisions: 1,
    drafts: 1,
    subproblems: { done: 2, claimed: 1, open: 0 },
    rejectedHypotheses: 1,
    rivals: 1,
    claimsWithoutSuperseding: 0,
    subproblemsWithSecondAnswer: 0,
  },
  rounds: 4,
  status: 'completed',
  reason: answer === null ? 'budget_rounds' : 'completed',
  entries: 9,
  usage: { ...zeroUsage(), inputTokens: 5_000, outputTokens: 1_500, costUsd },
  costUsd,
  elapsedMs: 1_000,
  ...overrides,
});

const options = (overrides: Partial<PassOptions> = {}): PassOptions => ({
  passId: 'p1',
  problems: [problem('one'), problem('two')],
  capUsd: 1,
  runCapUsd: 0.08,
  judgeOrders: 2,
  refreshBaselines: false,
  baselineMaxOutputTokens: 2_048,
  judgeMaxOutputTokens: 1_024,
  ...overrides,
});

const deps = (overrides: Partial<PassDeps> = {}): PassDeps & { lines: string[] } => {
  const lines: string[] = [];
  return {
    lines,
    runSwarm: (p, cap) => Promise.resolve(ok(swarmOutcome(p.id, Math.min(0.02, cap)))),
    baselineModel: createFakeBaseline(SCENARIO_PRICING),
    baselineAllowanceModel: null,
    judgeModel: createFakeJudge(SCENARIO_PRICING),
    cache: memoryCache(),
    month: null,
    now: () => Date.UTC(2026, 10, 10, 12),
    log: (line) => lines.push(line),
    rng: mulberry32(7),
    ...overrides,
  };
};

// What the fake baseline and judge cost at SCENARIO_PRICING ($1 in, $5 out per million).
const BASELINE_COST =
  (FAKE_BASELINE_USAGE.inputTokens * 1 + FAKE_BASELINE_USAGE.outputTokens * 5) / 1e6;
const JUDGE_COST = (FAKE_JUDGE_USAGE.inputTokens * 1 + FAKE_JUDGE_USAGE.outputTokens * 5) / 1e6;

describe('runPass', () => {
  it('runs baseline, swarm and both judging orders per problem, charging the pass for each', async () => {
    const d = deps();
    const pass = await runPass(options(), d);
    expect(pass.results.map((r) => r.problem.id)).toEqual(['one', 'two']);
    expect(pass.stopped).toBeNull();
    for (const r of pass.results) {
      expect(r.swarm?.costUsd).toBe(0.02);
      expect(r.baseline?.capUsd).toBe(0.08);
      expect(r.baselineCached).toBe(false);
      expect(r.judgements.length).toBe(2);
      expect(r.judgements[0]?.order.A).not.toBe(r.judgements[1]?.order.A);
      expect(r.scores.swarm).not.toBeNull();
      expect(r.scores.consistency).toBe(0);
      expect(r.costUsd).toBeCloseTo(0.02 + BASELINE_COST + 2 * JUDGE_COST, 9);
    }
    expect(pass.spentUsd).toBeCloseTo(2 * (0.02 + BASELINE_COST + 2 * JUDGE_COST), 9);
    expect(pass.aggregate.judged).toBe(2);
    expect(pass.aggregate.firstShownPreferred.of).toBeGreaterThan(0);
    // Every call was tagged with the pass, not a swarm run.
    const judgeCalls = (d.judgeModel as ReturnType<typeof createFakeJudge>).calls;
    expect(judgeCalls.length).toBe(4);
    expect(
      judgeCalls.every(
        (c) => c.request.tags.runId === 'eval:p1' && c.request.tags.role === 'eval-judge',
      ),
    ).toBe(true);
  });

  it('reuses a cached baseline unless asked to refresh', async () => {
    const cache = memoryCache();
    const first = await runPass(options(), deps({ cache }));
    expect(cache.records.size).toBe(2);
    const baseline = createFakeBaseline(SCENARIO_PRICING);
    const second = await runPass(options(), deps({ cache, baselineModel: baseline }));
    expect(baseline.calls.length).toBe(0);
    expect(second.results.every((r) => r.baselineCached)).toBe(true);
    expect(second.spentUsd).toBeCloseTo(first.spentUsd - 2 * BASELINE_COST, 9);
    const third = await runPass(
      options({ refreshBaselines: true }),
      deps({ cache, baselineModel: baseline }),
    );
    expect(baseline.calls.length).toBe(2);
    expect(third.results.every((r) => !r.baselineCached)).toBe(true);
  });

  it('caps the swarm run at what the pass has left and stops when nothing is left', async () => {
    const caps: number[] = [];
    const d = deps({
      runSwarm: (p, cap) => {
        caps.push(cap);
        return Promise.resolve(ok(swarmOutcome(p.id, cap)));
      },
    });
    const pass = await runPass(options({ capUsd: 0.1, runCapUsd: 0.08 }), d);
    // Problem one: the baseline is capped at the run cap, then the swarm at min(0.08, what
    // the baseline left of $0.10); the judge calls fit what remains.
    expect(pass.results[0]?.baseline?.capUsd).toBe(0.08);
    expect(caps[0]).toBe(0.08);
    // Problem two gets whatever is left, then the pass is out of money.
    expect(caps[1]).toBeLessThan(0.02);
    expect(pass.results.length).toBe(2);
    expect(pass.spentUsd).toBeLessThanOrEqual(0.1 + 1e-9);
    const third = await runPass(
      options({
        capUsd: 0.1,
        runCapUsd: 0.08,
        problems: [problem('a'), problem('b'), problem('c')],
      }),
      d,
    );
    expect(third.stopped?.reason === 'pass_cap' || third.results.length === 3).toBe(true);
    if (third.stopped?.reason === 'pass_cap') expect(third.stopped.beforeProblem).toBe('c');
  });

  it('skips the baseline and the judge with a reason when they do not fit or cannot run', async () => {
    const d = deps({
      // A run cap too small for a paid baseline call: both arms share the cap, so it is skipped.
      runSwarm: (p) => Promise.resolve(ok(swarmOutcome(p.id, 0))),
    });
    const pass = await runPass(options({ problems: [problem('free')], runCapUsd: 0.0001 }), d);
    const r = pass.results[0];
    expect(r?.baseline).toBeNull();
    expect(r?.baselineSkipped).toContain('does not cover');
    expect(r?.judgeSkipped).toEqual(['no baseline answer']);
    expect(r?.scores).toMatchObject({ swarm: null, baseline: 0, winner: null });

    const noAnswer = await runPass(
      options({ problems: [problem('silent')] }),
      deps({ runSwarm: (p) => Promise.resolve(ok(swarmOutcome(p.id, 0.02, null))) }),
    );
    expect(noAnswer.results[0]?.judgeSkipped).toEqual(['the swarm produced no synthesis']);
    expect(noAnswer.results[0]?.scores).toMatchObject({ swarm: 0, baseline: null });
    expect(noAnswer.aggregate.judged).toBe(0);
  });

  it('records a failed swarm run and a judge that answers badly, and goes on', async () => {
    const badJudge = createFakeModel({
      id: 'bad-judge',
      pricing: SCENARIO_PRICING,
      script: () => ({ object: { nonsense: true }, usage: FAKE_JUDGE_USAGE }),
    });
    const d = deps({
      runSwarm: (p) =>
        Promise.resolve(
          p.id === 'one' ? err('provider unreachable') : ok(swarmOutcome(p.id, 0.02)),
        ),
      judgeModel: badJudge,
    });
    const pass = await runPass(options(), d);
    expect(pass.results[0]).toMatchObject({ swarm: null, swarmError: 'provider unreachable' });
    // The baseline comes first, so it was made (and cached) before the swarm failed.
    expect(pass.results[0]?.baseline).not.toBeNull();
    expect(pass.results[0]?.judgements).toEqual([]);
    expect(pass.results[1]?.judgements).toEqual([]);
    expect(pass.results[1]?.judgeSkipped).toEqual([
      expect.stringContaining('invalid_output'),
      expect.stringContaining('invalid_output'),
    ]);
    // The failed judge calls still cost tokens, and the pass was charged for them.
    expect(pass.spentUsd).toBeCloseTo(0.02 + 2 * BASELINE_COST + 2 * JUDGE_COST, 9);
  });

  it('makes the baseline first and hands its output allowance to the swarm for its write-up', async () => {
    const order: string[] = [];
    const allowances: (number | null)[] = [];
    const baseline = createFakeBaseline(SCENARIO_PRICING);
    const cache = memoryCache();
    const d = deps({
      cache,
      baselineModel: {
        ...baseline,
        generateObject: (request) => {
          order.push('baseline');
          return baseline.generateObject(request);
        },
      },
      runSwarm: (p, cap, writeUpMaxOutputTokens) => {
        order.push('swarm');
        allowances.push(writeUpMaxOutputTokens);
        return Promise.resolve(ok(swarmOutcome(p.id, Math.min(0.02, cap))));
      },
    });
    const pass = await runPass(options({ problems: [problem('one')] }), d);
    expect(order).toEqual(['baseline', 'swarm']);
    // Under an $0.08 cap the whole 2,048-token allowance fits, and the swarm gets the same.
    expect(pass.results[0]?.baseline?.maxOutputTokens).toBe(2_048);
    expect(allowances).toEqual([2_048]);
    expect(d.lines.join('\n')).toContain('final write-up allowed 2048 output tokens');

    // A cached baseline made under a tighter cap: the swarm is given that record's allowance,
    // because that is the answer it will be judged against.
    const stored = cache.records.get('one|fake-baseline');
    if (stored === undefined) throw new Error('no cached baseline');
    cache.records.set('one|fake-baseline', { ...stored, maxOutputTokens: 1_200, wordBudget: 400 });
    await runPass(options({ problems: [problem('one')] }), d);
    expect(order).toEqual(['baseline', 'swarm', 'swarm']);
    expect(allowances).toEqual([2_048, 1_200]);
  });

  it('falls back to what a baseline would have been given, or to the run default', async () => {
    const allowances: (number | null)[] = [];
    const runSwarm: PassDeps['runSwarm'] = (p, cap, writeUpMaxOutputTokens) => {
      allowances.push(writeUpMaxOutputTokens);
      return Promise.resolve(ok(swarmOutcome(p.id, Math.min(0.001, cap))));
    };
    // The baseline's answer fails its schema: no record, but the allowance it was sized for stands.
    const broken = createFakeModel({
      id: 'fake-baseline',
      pricing: SCENARIO_PRICING,
      script: () => ({ object: { nonsense: true }, usage: FAKE_BASELINE_USAGE }),
    });
    const failed = await runPass(
      options({ problems: [problem('one')] }),
      deps({ baselineModel: broken, runSwarm }),
    );
    expect(failed.results[0]?.baseline).toBeNull();
    expect(allowances).toEqual([2_048]);
    // No baseline call fits the cap at all: the swarm keeps its own default.
    await runPass(options({ problems: [problem('one')], runCapUsd: 0.0001 }), deps({ runSwarm }));
    expect(allowances).toEqual([2_048, null]);
  });

  it('pauses the pass before a problem when the month is spent', async () => {
    let spent = 4.9;
    const d = deps({
      month: {
        spentUsd: () => {
          spent += 0.1;
          return Promise.resolve(spent);
        },
        limitUsd: 5,
      },
    });
    const pass = await runPass(options(), d);
    expect(pass.results.length).toBe(0);
    expect(pass.stopped).toEqual({
      reason: 'monthly_budget',
      beforeProblem: 'one',
      spentUsd: 5,
      limitUsd: 5,
    });
  });
});

describe('PassBudget', () => {
  it('never reports a negative remainder', () => {
    const budget = new PassBudget(0.05);
    budget.charge(0.03);
    expect(budget.remainingUsd).toBeCloseTo(0.02, 9);
    budget.charge(0.05);
    expect(budget.remainingUsd).toBe(0);
    expect(budget.spentUsd).toBeCloseTo(0.08, 9);
  });
});

describe('report', () => {
  it('renders the header, the per-problem table and the pairs, and picks three distinct pairs', async () => {
    const d = deps();
    const pass = await runPass(
      options({ problems: [problem('one'), problem('two'), problem('three')] }),
      d,
    );
    const meta = {
      label: 'test',
      profile: {
        name: 'dev',
        roles: Object.fromEntries(
          ['planner', 'researcher', 'solver', 'critic', 'synthesizer'].map((role) => [
            role,
            { alias: 'local-fast', provider: 'ollama' as const, model: 'qwen', think: false },
          ]),
        ) as never,
        bidder: null,
        fallback: null,
        paid: false,
      },
      evalModels: {
        baseline: { alias: 'local-fast', provider: 'ollama' as const, model: 'qwen' },
        judge: { alias: 'local-fast', provider: 'ollama' as const, model: 'qwen' },
      },
      commit: 'abc1234',
      baselineModelId: 'fake-baseline',
      judgeModelId: 'fake-judge',
    };
    const report = renderReport(pass, meta);
    expect(report).toContain('# Eval pass: test');
    expect(report).toContain('`abc1234`');
    expect(report).toContain('| one | `run-one` | 4 | completed/completed |');
    expect(report).toContain('## Pairs written out');
    const pairs = selectPairs(pass);
    expect(pairs.length).toBeGreaterThanOrEqual(1);
    expect(pairs.length).toBeLessThanOrEqual(3);
    expect(new Set(pairs.map((p) => p.result.problem.id)).size).toBe(pairs.length);
    const pair = pairs[0];
    if (pair === undefined) return;
    const text = renderPair(pair.result, pair.why);
    expect(text).toContain('## Swarm answer');
    expect(text).toContain('## Baseline answer');
    expect(text).toContain('### Order 1');
    expect(text).toContain('### Order 2');
    expect(text).toContain('| coverage | 3 |');
  });

  it('notes a cached baseline whose cap drifted from the swarm cost', async () => {
    const cache = memoryCache();
    await runPass(options({ problems: [problem('one')] }), deps({ cache }));
    const pass = await runPass(
      options({ problems: [problem('one')], runCapUsd: 0.2 }),
      deps({ cache, runSwarm: (p) => Promise.resolve(ok(swarmOutcome(p.id, 0.05))) }),
    );
    const local = { alias: 'x', provider: 'ollama' as const, model: 'm' };
    const report = renderReport(pass, {
      label: 'drift',
      profile: {
        name: 'dev',
        roles: {
          planner: local,
          researcher: local,
          solver: local,
          critic: local,
          synthesizer: local,
        },
        bidder: null,
        fallback: null,
        paid: false,
      },
      evalModels: {
        baseline: { alias: 'x', provider: 'ollama', model: 'm' },
        judge: { alias: 'x', provider: 'ollama', model: 'm' },
      },
      commit: null,
      baselineModelId: 'fake-baseline',
      judgeModelId: 'fake-judge',
    });
    expect(report).toContain('cached baseline was capped at $0.0800');
    expect(report).toContain("this pass's cap is $0.2000");
  });
});

describe('report: what each arm wrote, and where the swarm scored low', () => {
  const local = { alias: 'x', provider: 'ollama' as const, model: 'm' };
  const meta = {
    label: 'answers',
    profile: {
      name: 'dev',
      roles: {
        planner: local,
        researcher: local,
        solver: local,
        critic: local,
        synthesizer: local,
      },
      bidder: null,
      fallback: null,
      paid: false,
    },
    evalModels: { baseline: local, judge: local },
    commit: null,
    baselineModelId: 'fake-baseline',
    judgeModelId: 'fake-judge',
  };
  // A judge that gives both answers the same scores, whatever the order: 1, 3 and 0.
  const strictJudge = () =>
    createFakeModel({
      id: 'fake-judge',
      pricing: SCENARIO_PRICING,
      script: () => {
        const scores = {
          coverage: { reason: 'Leaves the second half of the question out.', score: 1 },
          clarity: { reason: 'Clear enough.', score: 3 },
          honesty: { reason: 'Names no limit at all | not one.', score: 0 },
        };
        return {
          object: { A: scores, B: scores, overall: 'tie', note: 'Much the same.' },
          usage: FAKE_JUDGE_USAGE,
        };
      },
    });

  it('tabulates how far each run closed its loop', async () => {
    const pass = await runPass(
      options({ problems: [problem('one'), problem('two')] }),
      deps({
        runSwarm: (p, cap) =>
          Promise.resolve(
            p.id === 'two'
              ? err('provider unreachable')
              : ok(swarmOutcome(p.id, Math.min(0.02, cap))),
          ),
      }),
    );
    const report = renderReport(pass, meta);
    expect(report).toContain('## Closing the loop');
    expect(report).toContain(
      '| one | 4 | completed | 2 / 5 | 1 | 1 major, 1 minor (1 named as resolved, target not replaced) | 1 / 8 | 2 | 1 | 1 (1) | 1 | 2 / 1 / 0 | 0 | 0 |',
    );
    // A run that never happened has nothing to count.
    expect(report).toContain('| two | — | — | — | — | — | — | — | — | — | — | — | — | — |');
  });

  it('counts words the way a reader would', () => {
    expect(wordCount('One two  three.\n\nFour, five!')).toBe(5);
    expect(wordCount('   ')).toBe(0);
  });

  it('tabulates the words each arm wrote against the words it was asked for', async () => {
    const pass = await runPass(
      options({ problems: [problem('one')] }),
      deps({
        runSwarm: (p, cap) =>
          Promise.resolve(
            ok(swarmOutcome(p.id, Math.min(0.02, cap), 'One two three four five six seven.')),
          ),
      }),
    );
    const report = renderReport(pass, meta);
    expect(report).toContain('## Answers');
    // The fake baseline writes 31 words; both arms were asked for 650.
    const baselineWords = wordCount(pass.results[0]?.baseline?.answer ?? '');
    expect(report).toContain(
      `| one | final write-up | 7 / 650 | $0.0040 | ${String(baselineWords)} / 650 | complete |`,
    );
    expect(report).not.toContain('asked for different lengths');
    expect(report).not.toContain('is a draft');
    const pair = selectPairs(pass)[0];
    if (pair === undefined) throw new Error('no pair');
    expect(renderPair(pair.result, pair.why)).toContain(
      '; the final write-up, asked for about 650 words, 7 written._',
    );
  });

  it('says so when a draft was judged because the write-up failed, and when the budgets differ', async () => {
    const pass = await runPass(
      options({ problems: [problem('one'), problem('two')] }),
      deps({
        runSwarm: (p, cap) =>
          Promise.resolve(
            ok(
              p.id === 'one'
                ? swarmOutcome(p.id, Math.min(0.02, cap), 'Only a draft.', {
                    stage: 'draft',
                    writeUp: {
                      maxOutputTokens: 2_048,
                      wordBudget: 650,
                      written: false,
                      costUsd: 0.001,
                      attempts: 1,
                      short: false,
                      retriedFor: [],
                      leaks: [],
                    },
                    writeUpFailure: 'invalid_output: cites.0: Invalid option',
                  })
                : swarmOutcome(p.id, Math.min(0.02, cap), 'A final answer.', {
                    writeUp: {
                      maxOutputTokens: 900,
                      wordBudget: 300,
                      written: true,
                      costUsd: 0.002,
                      attempts: 1,
                      short: false,
                      retriedFor: [],
                      leaks: [],
                    },
                  }),
            ),
          ),
      }),
    );
    const report = renderReport(pass, meta);
    expect(report).toContain(
      '| one | **draft** (invalid_output: cites.0: Invalid option) | 3 / 650 | $0.0010 |',
    );
    expect(report).toContain(
      "`one`: the swarm's answer is a draft, not its final write-up (invalid_output: cites.0: Invalid option); the judge scored the draft.",
    );
    expect(report).toContain('| two | final write-up | 3 / 300 | $0.0020 |');
    expect(report).toContain(
      "`two`: the arms were asked for different lengths, the swarm's write-up for about 300 words and the baseline for about 650.",
    );
  });

  it('says when a write-up needed a second attempt, and when it is still short', async () => {
    const pass = await runPass(
      options({ problems: [problem('one'), problem('two')] }),
      deps({
        runSwarm: (p, cap) =>
          Promise.resolve(
            ok(
              swarmOutcome(p.id, Math.min(0.02, cap), 'One two three four five six seven.', {
                writeUp: {
                  maxOutputTokens: 2_048,
                  wordBudget: 650,
                  written: true,
                  costUsd: 0.006,
                  attempts: 2,
                  short: p.id === 'one',
                  retriedFor: ['short'],
                  leaks: [],
                },
              }),
            ),
          ),
      }),
    );
    const report = renderReport(pass, meta);
    expect(report).toContain(
      '| one | final write-up, **short** after a second attempt | 7 / 650 | $0.0060 |',
    );
    expect(report).toContain('| two | final write-up, on the second attempt | 7 / 650 | $0.0060 |');
    expect(report).toContain(
      "`one`: the swarm's write-up came back under half its word budget twice; the longer attempt, 7 words of about 650 asked for, was judged.",
    );
    expect(report).not.toContain("`two`: the swarm's write-up came back under half");
  });

  it('lists every criterion a judgement gave the swarm 0 or 1 on, with the reason', async () => {
    const pass = await runPass(
      options({ problems: [problem('one')] }),
      deps({ judgeModel: strictJudge() }),
    );
    const low = lowSwarmScores(pass);
    // Two orders, two low criteria each: coverage at 1 and honesty at 0; clarity at 3 is left out.
    expect(low.map((item) => [item.criterionId, item.swarmScore, item.baselineScore])).toEqual([
      ['coverage', 1, 1],
      ['honesty', 0, 0],
      ['coverage', 1, 1],
      ['honesty', 0, 0],
    ]);
    expect(new Set(low.map((item) => item.shownFirst))).toEqual(new Set(['swarm', 'baseline']));
    expect(low[0]).toMatchObject({ problemId: 'one', weight: 3 });

    const report = renderReport(pass, meta);
    expect(report).toContain('## Where the swarm scored 0 or 1');
    expect(report).toMatch(
      /- `one` · \*\*coverage\*\* \(weight 3; order A = (swarm|baseline)\): swarm 1, baseline 1\. Leaves the second half of the question out\./,
    );
    // A pipe in the judge's words cannot break the list or a table.
    expect(report).toContain('swarm 0, baseline 0. Names no limit at all \\| not one.');
    expect(report.indexOf('## Where the swarm scored 0 or 1')).toBeLessThan(
      report.indexOf('## Pairs written out'),
    );
  });

  it('says nowhere when the swarm never scored below 2, and nothing when nothing was judged', async () => {
    const generous = createFakeModel({
      id: 'fake-judge',
      pricing: SCENARIO_PRICING,
      script: () => {
        const scores = Object.fromEntries(
          ['coverage', 'clarity', 'honesty'].map((id) => [id, { reason: 'Good.', score: 2 }]),
        );
        return {
          object: { A: scores, B: scores, overall: 'tie', note: '' },
          usage: FAKE_JUDGE_USAGE,
        };
      },
    });
    const judged = await runPass(
      options({ problems: [problem('one')] }),
      deps({ judgeModel: generous }),
    );
    expect(lowSwarmScores(judged)).toEqual([]);
    expect(renderReport(judged, meta)).toContain(
      'Nowhere: the swarm scored 2 or 3 on every criterion of every judgement.',
    );
    const unjudged = await runPass(
      options({ problems: [problem('one')] }),
      deps({ runSwarm: (p) => Promise.resolve(ok(swarmOutcome(p.id, 0.02, null))) }),
    );
    expect(renderReport(unjudged, meta)).not.toContain('## Where the swarm scored 0 or 1');
    expect(renderReport(unjudged, meta)).toContain('| one | none | — | — |');
  });
});

describe('baseline cache keys', () => {
  it('ignores a stored answer from another model or an older prompt', async () => {
    const cache = memoryCache();
    await runPass(options({ problems: [problem('one')] }), deps({ cache }));
    const stored = cache.records.get('one|fake-baseline');
    expect(stored).toBeDefined();
    if (stored === undefined) return;
    // Another model's answer under the same problem id is not this model's baseline.
    cache.records.set('one|other-model', { ...stored, modelId: 'other-model' });
    const other = createFakeBaseline(SCENARIO_PRICING);
    const otherPass = await runPass(
      options({ problems: [problem('one')] }),
      deps({ cache, baselineModel: { ...other, id: 'other-model' } }),
    );
    expect(otherPass.results[0]?.baselineCached).toBe(false);
    // A record whose key no longer matches (the prompt or the problem changed) is redone.
    cache.records.set('one|fake-baseline', { ...stored, key: 'stale' });
    const fresh = createFakeBaseline(SCENARIO_PRICING);
    const redone = await runPass(
      options({ problems: [problem('one')] }),
      deps({ cache, baselineModel: fresh }),
    );
    expect(fresh.calls.length).toBe(1);
    expect(redone.results[0]?.baselineCached).toBe(false);
  });
});

describe('what the judge sees', () => {
  it('is both answers with board handles removed, while the report keeps the original', async () => {
    const judge = createFakeJudge(SCENARIO_PRICING);
    const answer = 'Adopt a canary (H16). Evidence E24 and E28 confirm it.';
    const pass = await runPass(
      options({ problems: [problem('one')], judgeOrders: 1 }),
      deps({
        judgeModel: judge,
        runSwarm: (p) => Promise.resolve(ok(swarmOutcome(p.id, 0.02, answer))),
      }),
    );
    const prompt = judge.calls[0]?.request.prompt ?? '';
    expect(prompt).toContain('Adopt a canary. Evidence and confirm it.');
    expect(prompt).not.toMatch(/\b[HE]\d+\b/);
    expect(pass.results[0]?.swarm?.answer).toBe(answer);
  });

  it('notes a baseline that used its whole allowance in the table and the notes', async () => {
    const truncating = createFakeModel({
      id: 'fake-baseline',
      pricing: SCENARIO_PRICING,
      script: () => ({
        object: { paragraphs: ['A long answer that ran out of room'] },
        usage: { inputTokens: 500, outputTokens: 2_048 },
      }),
    });
    const pass = await runPass(
      options({ problems: [problem('one')], capUsd: 10, runCapUsd: 1 }),
      deps({
        baselineModel: truncating,
        runSwarm: (p) => Promise.resolve(ok(swarmOutcome(p.id, 0.5))),
      }),
    );
    expect(pass.results[0]?.baseline?.truncated).toBe(true);
    const local = { alias: 'x', provider: 'ollama' as const, model: 'm' };
    const report = renderReport(pass, {
      label: 'cut',
      profile: {
        name: 'dev',
        roles: {
          planner: local,
          researcher: local,
          solver: local,
          critic: local,
          synthesizer: local,
        },
        bidder: null,
        fallback: null,
        paid: false,
      },
      evalModels: { baseline: local, judge: local },
      commit: null,
      baselineModelId: 'fake-baseline',
      judgeModelId: 'fake-judge',
    });
    expect(report).toContain('2048/2048 (650 words) **truncated**');
    expect(report).toContain('baseline truncated at its allowance');
    expect(report).toContain('1 baseline answer used the whole output allowance (one)');
  });
});

describe('a stand-in baseline model (pnpm eval --baseline)', () => {
  // Ten times the scripted prices: under the 8-cent cap its allowance has to shrink.
  const dear = createFakeBaseline({
    tiers: [
      {
        upToPromptTokens: null,
        inputPerMTok: 10,
        outputPerMTok: 50,
        cacheReadPerMTok: 10,
        cacheWritePerMTok: 10,
      },
    ],
  });

  it('is given the allowance the profile’s own baseline would have had, and so is the write-up', async () => {
    const own = sizeBaseline({
      model: dear,
      problem: problem('one'),
      capUsd: 0.08,
      maxOutputTokens: 2_048,
    });
    if (!own.fit.fits) throw new Error('the dear model does not fit at all');
    expect(own.fit.maxOutputTokens).toBeLessThan(2_048);

    const allowances: (number | null)[] = [];
    const cheap = createFakeBaseline(SCENARIO_PRICING);
    const pass = await runPass(
      options({ problems: [problem('one')] }),
      deps({
        baselineModel: cheap,
        baselineAllowanceModel: dear,
        runSwarm: (p, cap, writeUpMaxOutputTokens) => {
          allowances.push(writeUpMaxOutputTokens);
          return Promise.resolve(ok(swarmOutcome(p.id, Math.min(0.02, cap))));
        },
      }),
    );
    const baseline = pass.results[0]?.baseline;
    // The cheap model wrote it, at the dear model's allowance and word budget, under the same cap.
    expect(baseline?.modelId).toBe(cheap.id);
    expect(baseline?.maxOutputTokens).toBe(own.fit.maxOutputTokens);
    expect(baseline?.wordBudget).toBe(own.wordBudget);
    expect(baseline?.capUsd).toBe(0.08);
    expect(allowances).toEqual([own.fit.maxOutputTokens]);
    // The dear model was only measured against: it was never called.
    expect(dear.calls).toHaveLength(0);
    expect(cheap.calls).toHaveLength(1);
  });

  it('changes nothing when there is none', async () => {
    const allowances: (number | null)[] = [];
    const pass = await runPass(
      options({ problems: [problem('one')] }),
      deps({
        runSwarm: (p, cap, writeUpMaxOutputTokens) => {
          allowances.push(writeUpMaxOutputTokens);
          return Promise.resolve(ok(swarmOutcome(p.id, Math.min(0.02, cap))));
        },
      }),
    );
    expect(pass.results[0]?.baseline?.maxOutputTokens).toBe(2_048);
    expect(allowances).toEqual([2_048]);
  });

  it('is named in the report’s header', async () => {
    const pass = await runPass(options({ problems: [problem('one')] }), deps());
    const local = { alias: 'x', provider: 'ollama' as const, model: 'm' };
    const meta = {
      label: 'control',
      profile: {
        name: 'dev',
        roles: {
          planner: local,
          researcher: local,
          solver: local,
          critic: local,
          synthesizer: local,
        },
        bidder: null,
        fallback: null,
        paid: false,
      },
      evalModels: { baseline: local, judge: local },
      commit: null,
      baselineModelId: 'fake-baseline',
      judgeModelId: 'fake-judge',
    };
    expect(renderReport(pass, meta)).not.toContain('Control pass');
    expect(
      renderReport(pass, { ...meta, baselineNote: '--baseline x: this model writes the baseline' }),
    ).toContain('  - **Control pass.** --baseline x: this model writes the baseline.');
  });
});

describe('a baseline that stays short', () => {
  // A baseline model that always answers in five words.
  const terse = () =>
    createFakeModel({
      id: 'fake-baseline',
      pricing: SCENARIO_PRICING,
      script: () => ({
        object: { paragraphs: ['Recommendation: run a six-week, once-weekly'] },
        usage: FAKE_BASELINE_USAGE,
      }),
    });
  const local = { alias: 'x', provider: 'ollama' as const, model: 'm' };
  const meta = {
    label: 'void',
    profile: {
      name: 'dev',
      roles: {
        planner: local,
        researcher: local,
        solver: local,
        critic: local,
        synthesizer: local,
      },
      bidder: null,
      fallback: null,
      paid: false,
    },
    evalModels: { baseline: local, judge: local },
    commit: null,
    baselineModelId: 'fake-baseline',
    judgeModelId: 'fake-judge',
  };

  it('is void: asked for twice, not cached, not judged, and left out of the means', async () => {
    const cache = memoryCache();
    const baselineModel = terse();
    const judgeModel = createFakeJudge(SCENARIO_PRICING);
    const pass = await runPass(
      options({ problems: [problem('one')] }),
      deps({ cache, baselineModel, judgeModel }),
    );
    const [result] = pass.results;
    expect(baselineModel.calls).toHaveLength(2);
    expect(result?.baseline).toMatchObject({ void: true, attempts: 2 });
    expect(cache.records.size).toBe(0);
    // The swarm still ran; nothing was judged, and nobody scored 0.
    expect(result?.swarm?.answer).not.toBeNull();
    expect(judgeModel.calls).toHaveLength(0);
    expect(result?.scores).toMatchObject({ swarm: null, baseline: null, winner: null });
    expect(result?.judgeSkipped).toEqual([
      'the baseline is void: 5 words of about 650 asked for, after a second attempt',
    ]);
    expect(pass.aggregate).toMatchObject({ judged: 0, swarmMean: null, baselineMean: null });
    // Both attempts were paid for.
    expect(pass.spentUsd).toBeCloseTo(2 * BASELINE_COST + 0.02, 10);

    const report = renderReport(pass, meta);
    expect(report).toContain(
      '| 5 / 650 | **void** (under half its word budget after a second attempt; not judged) |',
    );
    expect(report).toContain(
      '`one`: the baseline is void (5 words of about 650 asked for, after a second attempt). The pair was not judged and is left out of the means.',
    );
  });

  it('is made again when it comes from the cache', async () => {
    const cache = memoryCache();
    // A pass with a terse model caches nothing; put a short record there by hand, as the
    // pass of 2026-11-17 did before the guard existed.
    const first = await runPass(options({ problems: [problem('one')] }), deps({ cache }));
    const good = first.results[0]?.baseline;
    if (good === undefined || good === null) throw new Error('no baseline');
    await cache.put({ ...good, answer: 'Recommendation: run a six-week, once-weekly' });

    const baselineModel = createFakeBaseline(SCENARIO_PRICING);
    const second = await runPass(
      options({ problems: [problem('one')] }),
      deps({ cache, baselineModel }),
    );
    expect(second.results[0]?.baselineCached).toBe(false);
    expect(baselineModel.calls).toHaveLength(1);
    expect(second.results[0]?.baseline?.void).toBe(false);
    expect(second.results[0]?.judgements).toHaveLength(2);
  });
});
