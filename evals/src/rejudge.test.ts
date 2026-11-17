import { createFakeModel, err, ok } from '@team/core';
import { SCENARIO_PRICING } from '@team/core/testing';
import { describe, expect, it } from 'vitest';

import { baselineCacheKey, type BaselineCache, type BaselineRecord } from './baseline';
import { createFakeBaseline, createFakeJudge, FAKE_BASELINE_USAGE, FAKE_JUDGE_USAGE } from './fake';
import {
  pairwiseHistory,
  passLabelOf,
  PriorReportSchema,
  swarmAnswerOf,
  type PriorPass,
} from './history';
import { judgementSchema, soloJudgePrompt, soloJudgementSchema, SOLO_JUDGE_SYSTEM } from './judge';
import { mulberry32 } from './judge';
import type { Problem } from './problems';
import {
  parseAnswerRef,
  refKey,
  runRejudge,
  type RejudgeDeps,
  type RejudgeOptions,
} from './rejudge';
import { answerRows, renderRejudgeReport, type RejudgeMeta } from './rejudge-report';
import { wordCount } from './words';

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

const JUDGE_COST = (FAKE_JUDGE_USAGE.inputTokens * 1 + FAKE_JUDGE_USAGE.outputTokens * 5) / 1e6;
const BASELINE_COST =
  (FAKE_BASELINE_USAGE.inputTokens * 1 + FAKE_BASELINE_USAGE.outputTokens * 5) / 1e6;

// An earlier pass's report, as report.ts writes it: one swarm answer and one baseline
// answer per problem, judged.
const priorPass = (label: string, swarmText: (id: string) => string, baselineText: string) => ({
  label,
  report: PriorReportSchema.parse({
    pass: {
      results: ['one', 'two'].map((id) => ({
        problem: { id },
        swarm: { runId: `run-${label}-${id}`, answer: swarmText(id), writeUp: { wordBudget: 650 } },
        baseline: { answer: baselineText, modelId: 'fake-baseline', wordBudget: 650 },
        judgements: [{}, {}],
        scores: { swarm: 70, baseline: 90 },
      })),
    },
  }),
});

const setup = () => {
  const cache = memoryCache();
  const judgeModel = createFakeJudge(SCENARIO_PRICING);
  const baselineModel = createFakeBaseline(SCENARIO_PRICING);
  const passes: PriorPass[] = [
    priorPass('earlier', (id) => `The earlier swarm answer for ${id}.`, 'placeholder'),
    priorPass('later', (id) => `The later swarm answer for ${id}.`, 'placeholder'),
  ];
  const lines: string[] = [];
  const deps: RejudgeDeps = {
    judgeModel,
    cache,
    baselineModels: new Map([['strong', baselineModel]]),
    allowanceModel: baselineModel,
    swarmAnswer: (pass, problemId) => swarmAnswerOf(passes, pass, problemId),
    now: () => Date.parse('2026-11-17T00:00:00Z'),
    log: (line) => lines.push(line),
    rng: mulberry32(7),
  };
  const options = (overrides: Partial<RejudgeOptions> = {}): RejudgeOptions => ({
    sessionId: 's1',
    problems: [problem('one'), problem('two')],
    capUsd: 1,
    runCapUsd: 0.08,
    pairs: [{ pass: 'later', alias: 'strong' }],
    solo: [
      { kind: 'baseline', alias: 'strong' },
      { kind: 'swarm', pass: 'earlier' },
      { kind: 'swarm', pass: 'later' },
    ],
    judgeOrders: 2,
    judgeMaxOutputTokens: 1_024,
    baselineMaxOutputTokens: 2_048,
    ...overrides,
  });
  return { cache, judgeModel, baselineModel, passes, lines, deps, options };
};

describe('answer references', () => {
  it('are swarm:<pass> or baseline:<alias>', () => {
    expect(parseAnswerRef('swarm:step2b')).toEqual(ok({ kind: 'swarm', pass: 'step2b' }));
    expect(parseAnswerRef('baseline:haiku')).toEqual(ok({ kind: 'baseline', alias: 'haiku' }));
    expect(refKey({ kind: 'baseline', alias: 'haiku' })).toBe('baseline:haiku');
    for (const bad of ['haiku', 'swarm:', 'judge:x', 'swarm:a:b']) {
      expect(parseAnswerRef(bad).ok, bad).toBe(false);
    }
  });
});

describe('the solo judge', () => {
  it('is shown one answer and the rubric, and grades with the reason first', () => {
    const p = problem('one');
    const prompt = soloJudgePrompt(p, 'The answer.');
    expect(prompt).toContain('# Rubric');
    expect(prompt.endsWith('# Answer\n\nThe answer.')).toBe(true);
    expect(prompt).not.toContain('Answer A');
    expect(SOLO_JUDGE_SYSTEM).toContain('grading one answer');
    const schema = soloJudgementSchema(p);
    const good = {
      scores: {
        coverage: { reason: 'Covers it.', score: 3 },
        clarity: { reason: 'Clear.', score: 2 },
      },
      note: 'Fine.',
    };
    expect(schema.safeParse(good).success).toBe(true);
    expect(schema.safeParse({ ...good, scores: { coverage: good.scores.coverage } }).success).toBe(
      false,
    );
    expect(
      schema.safeParse({
        ...good,
        scores: { ...good.scores, clarity: { reason: 'Clear.', score: 4 } },
      }).success,
    ).toBe(false);
    // Not the pairwise shape.
    expect(judgementSchema(p).safeParse(good).success).toBe(false);
  });
});

describe('runRejudge', () => {
  it('judges the pairs in both orders and each answer alone, once, making a baseline the cache lacks', async () => {
    const { deps, options, judgeModel, baselineModel, cache } = setup();
    const result = await runRejudge(options(), deps);

    // Pairwise: two problems, both orders, the later pass's swarm answer beside the baseline.
    expect(result.pairs.map((p) => [p.problemId, p.pass, p.alias, p.judgements.length])).toEqual([
      ['one', 'later', 'strong', 2],
      ['two', 'later', 'strong', 2],
    ]);
    expect(result.pairs[0]?.swarm?.text).toBe('The later swarm answer for one.');
    expect(result.pairs[0]?.scores.swarm).not.toBeNull();
    // The baseline was not in the cache: made once per problem, kept, and reused for solo.
    expect(baselineModel.calls).toHaveLength(2);
    expect(result.made.map((m) => [m.problemId, m.alias, m.record.void])).toEqual([
      ['one', 'strong', false],
      ['two', 'strong', false],
    ]);
    expect(cache.records.size).toBe(2);

    // Solo: three answers on two problems, one call each, with a rubric percentage.
    expect(result.solo.map((s) => `${s.problemId}/${refKey(s.ref)}`)).toEqual([
      'one/baseline:strong',
      'one/swarm:earlier',
      'one/swarm:later',
      'two/baseline:strong',
      'two/swarm:earlier',
      'two/swarm:later',
    ]);
    expect(result.solo.every((s) => s.percent !== null && s.skipped === null)).toBe(true);
    expect(judgeModel.calls).toHaveLength(4 + 6);
    const soloCalls = judgeModel.calls.filter((c) => c.request.tags.role === 'eval-judge-solo');
    expect(soloCalls).toHaveLength(6);
    expect(soloCalls[0]?.request.prompt).not.toContain('# Answer A');
    expect(soloCalls[0]?.request.system).toBe(SOLO_JUDGE_SYSTEM);

    // The scripted judge scores a text the same alone as in a pair: so do the results.
    const pairSwarm = result.pairs[0]?.scores.swarm;
    const soloSwarm = result.solo.find(
      (s) => s.problemId === 'one' && refKey(s.ref) === 'swarm:later',
    );
    expect(soloSwarm?.percent).toBeCloseTo(pairSwarm ?? -1, 10);

    expect(result.spentUsd).toBeCloseTo(10 * JUDGE_COST + 2 * BASELINE_COST, 10);
  });

  it('uses a cached baseline as it is, and makes again one that is under half its word budget', async () => {
    const { deps, options, baselineModel, cache } = setup();
    await runRejudge(options({ problems: [problem('one')], solo: [] }), deps);
    expect(baselineModel.calls).toHaveLength(1);
    // Cached now: a second session makes nothing.
    const again = await runRejudge(options({ problems: [problem('one')], solo: [] }), deps);
    expect(baselineModel.calls).toHaveLength(1);
    expect(again.made).toEqual([]);
    // A five-word answer in the cache, as one pass left there: it is made again.
    const good = cache.records.get('one|fake-baseline');
    if (good === undefined) throw new Error('nothing cached');
    await cache.put({ ...good, answer: 'Recommendation: run a six-week, once-weekly' });
    const third = await runRejudge(options({ problems: [problem('one')], solo: [] }), deps);
    expect(baselineModel.calls).toHaveLength(2);
    expect(third.made).toHaveLength(1);
    expect(wordCount(cache.records.get('one|fake-baseline')?.answer ?? '')).toBeGreaterThan(300);
    expect(good.key).toBe(baselineCacheKey(problem('one'), 'fake-baseline'));
  });

  it('judges nothing against a void baseline, and says why', async () => {
    const { deps, options, judgeModel } = setup();
    const terse = createFakeModel({
      id: 'fake-terse',
      pricing: SCENARIO_PRICING,
      script: () => ({
        object: { paragraphs: ['Recommendation: run a six-week, once-weekly'] },
        usage: FAKE_BASELINE_USAGE,
      }),
    });
    const result = await runRejudge(
      options({
        problems: [problem('one')],
        solo: [{ kind: 'baseline', alias: 'weak' }],
        pairs: [{ pass: 'later', alias: 'weak' }],
      }),
      { ...deps, baselineModels: new Map([['weak', terse]]) },
    );
    expect(terse.calls).toHaveLength(2);
    expect(result.made[0]?.record).toMatchObject({ void: true, attempts: 2 });
    const reason =
      'the weak baseline is void: 5 words of about 650 asked for, after a second attempt';
    expect(result.pairs[0]).toMatchObject({ judgements: [], skipped: [reason], baseline: null });
    expect(result.pairs[0]?.scores).toMatchObject({ swarm: null, baseline: null });
    expect(result.solo[0]).toMatchObject({ percent: null, skipped: reason });
    expect(judgeModel.calls).toHaveLength(0);
  });

  it('stops judging when the cap is spent, and says which calls were not made', async () => {
    const { deps, options, judgeModel } = setup();
    // Room for the baseline and two judge calls, and then a hundredth of a cent: no third
    // call fits, however far its output allowance is shrunk.
    const capUsd = BASELINE_COST + 2 * JUDGE_COST + 0.0001;
    const result = await runRejudge(options({ problems: [problem('one')], capUsd }), deps);
    expect(result.pairs[0]?.judgements).toHaveLength(2);
    expect(result.solo.map((s) => s.percent)).toEqual([null, null, null]);
    expect(result.solo[0]?.skipped).toMatch(/left does not cover the judge call/);
    expect(judgeModel.calls).toHaveLength(2);
    expect(result.spentUsd).toBeLessThanOrEqual(capUsd);
  });

  it('reports a pass or a problem it cannot find instead of judging', async () => {
    const { deps, options, judgeModel } = setup();
    const result = await runRejudge(
      options({
        problems: [problem('one')],
        pairs: [],
        solo: [{ kind: 'swarm', pass: 'never-ran' }],
      }),
      deps,
    );
    expect(result.solo[0]?.skipped).toBe('no pass labelled "never-ran"; passes are earlier, later');
    expect(judgeModel.calls).toHaveLength(0);
    expect(deps.swarmAnswer('earlier', 'three')).toEqual(err('pass "earlier" did not run three'));
  });
});

describe('pairwise history and the per-problem table', () => {
  it('finds every score a text has had, as the swarm’s answer or as the baseline', () => {
    const shared = 'The same baseline answer.';
    const passes: PriorPass[] = [
      priorPass('first', (id) => `First swarm answer for ${id}.`, shared),
      priorPass('second', (id) => `Second swarm answer for ${id}.`, shared),
    ];
    expect(pairwiseHistory(passes, 'one', shared)).toEqual([
      { pass: 'first', score: 90, opponent: 'the swarm answer of first' },
      { pass: 'second', score: 90, opponent: 'the swarm answer of second' },
    ]);
    expect(pairwiseHistory(passes, 'one', 'Second swarm answer for one.')).toEqual([
      { pass: 'second', score: 70, opponent: 'the fake-baseline baseline' },
    ]);
    expect(pairwiseHistory(passes, 'one', 'Nobody wrote this.')).toEqual([]);
    expect(passLabelOf('2026-11-17-step2b')).toBe('step2b');
    expect(passLabelOf('baselines')).toBe('baselines');
  });

  it('puts each answer’s solo score beside its pairwise scores and their opponents', async () => {
    const { deps, options, passes } = setup();
    const result = await runRejudge(options({ problems: [problem('one')] }), deps);
    const meta: RejudgeMeta = {
      label: 'judge-only',
      commit: 'abc1234',
      judge: { alias: 'judge', modelId: 'fake-judge' },
      baselines: { strong: 'fake-baseline' },
    };
    const rows = answerRows(result, passes, 'one', meta.label);
    expect(rows.map((r) => refKey(r.ref))).toEqual([
      'baseline:strong',
      'swarm:earlier',
      'swarm:later',
    ]);
    const [baseline, earlier, later] = rows;
    // The earlier pass's swarm answer: its old pairwise score, and a solo score.
    expect(earlier?.pairwise).toEqual([
      { pass: 'earlier', score: 70, opponent: 'the fake-baseline baseline' },
    ]);
    expect(earlier?.solo).not.toBeNull();
    // The later one has its old score and the one this session gave it beside the baseline.
    expect(later?.pairwise.map((p) => [p.pass, p.opponent])).toEqual([
      ['later', 'the fake-baseline baseline'],
      ['judge-only', 'the fake-baseline baseline'],
    ]);
    // The baseline made in this session has only this session's score.
    expect(baseline?.pairwise.map((p) => [p.pass, p.opponent])).toEqual([
      ['judge-only', 'the swarm answer of later'],
    ]);

    const report = renderRejudgeReport(result, meta, [problem('one')], passes);
    expect(report).toContain('# Judge-only session: judge-only');
    expect(report).toContain('## Baselines made');
    expect(report).toContain('| one | of later | `strong` |');
    expect(report).toContain('### one');
    expect(report).toContain('| Answer | Words / asked | Solo | Pairwise so far |');
    expect(report).toMatch(
      /\| swarm answer of earlier \| 6 \/ 650 \| \d+\.\d% \| 70\.0% beside the fake-baseline baseline \(earlier\) \|/,
    );
    expect(report).toMatch(
      /\| strong baseline \(fake-baseline\) \| \d+ \/ 650 \| \d+\.\d% \| \d+\.\d% beside the swarm answer of later \(judge-only\) \|/,
    );
    expect(report).not.toContain('## Not judged');
  });
});
