import { createFakeModel, err, ok, zeroUsage } from '@team/core';
import { SCENARIO_PRICING } from '@team/core/testing';
import { describe, expect, it } from 'vitest';

import type { BaselineCache, BaselineRecord } from './baseline';
import { createFakeBaseline, createFakeJudge, FAKE_BASELINE_USAGE, FAKE_JUDGE_USAGE } from './fake';
import { mulberry32 } from './judge';
import { PassBudget, runPass, type PassDeps, type PassOptions, type SwarmOutcome } from './pass';
import type { Problem } from './problems';
import { renderPair, renderReport, selectPairs } from './report';

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

const swarmOutcome = (
  id: string,
  costUsd: number,
  answer: string | null = `Swarm answer for ${id}.`,
): SwarmOutcome => ({
  runId: `run-${id}`,
  answer,
  confidence: answer === null ? null : 0.9,
  rounds: 4,
  status: 'completed',
  reason: answer === null ? 'budget_rounds' : 'completed',
  entries: 9,
  usage: { ...zeroUsage(), inputTokens: 5_000, outputTokens: 1_500, costUsd },
  costUsd,
  elapsedMs: 1_000,
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
  it('runs swarm, baseline and both judging orders per problem, charging the pass for each', async () => {
    const d = deps();
    const pass = await runPass(options(), d);
    expect(pass.results.map((r) => r.problem.id)).toEqual(['one', 'two']);
    expect(pass.stopped).toBeNull();
    for (const r of pass.results) {
      expect(r.swarm?.costUsd).toBe(0.02);
      expect(r.baseline?.capUsd).toBe(0.02);
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
    // Problem one: swarm $0.08 of $0.10, baseline capped at min(0.08, 0.02 left), judge calls fit what remains.
    expect(caps[0]).toBe(0.08);
    expect(pass.results[0]?.baseline?.capUsd).toBeCloseTo(0.02, 9);
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
      // A swarm run that cost nothing: a paid baseline has no money to be capped at.
      runSwarm: (p) => Promise.resolve(ok(swarmOutcome(p.id, 0))),
    });
    const pass = await runPass(options({ problems: [problem('free')] }), d);
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
    expect(pass.results[1]?.judgements).toEqual([]);
    expect(pass.results[1]?.judgeSkipped).toEqual([
      expect.stringContaining('invalid_output'),
      expect.stringContaining('invalid_output'),
    ]);
    // The failed judge calls still cost tokens, and the pass was charged for them.
    expect(pass.spentUsd).toBeCloseTo(0.02 + BASELINE_COST + 2 * JUDGE_COST, 9);
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
      options({ problems: [problem('one')] }),
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
    expect(report).toContain('cached baseline was capped at $0.0200');
    expect(report).toContain('cost $0.0500');
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
    expect(report).toContain('2048/2048 (1000 words) **truncated**');
    expect(report).toContain('baseline truncated at its allowance');
    expect(report).toContain('1 baseline answer used the whole output allowance (one)');
  });
});
