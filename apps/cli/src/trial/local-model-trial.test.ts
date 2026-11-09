import { describe, expect, it } from 'vitest';

import {
  rankModels,
  renderRankingTable,
  renderSummaryTable,
  summarise,
  targetVariant,
  type TrialCell,
} from './local-model-trial';

const cell = (overrides: Partial<TrialCell>): TrialCell => ({
  model: 'a',
  role: 'researcher',
  think: false,
  board: 'mid-run',
  rep: 0,
  outcome: 'ok',
  errorKind: null,
  issues: [],
  contributions: 2,
  linkProblems: 0,
  handles: 10,
  latencyMs: 10_000,
  inputTokens: 1_500,
  outputTokens: 300,
  warnings: [],
  sample: {},
  ...overrides,
});

describe('local-model trial summaries', () => {
  const cells: TrialCell[] = [
    cell({ model: 'a', latencyMs: 8_000 }),
    cell({ model: 'a', latencyMs: 12_000, linkProblems: 1 }),
    cell({
      model: 'a',
      outcome: 'truncated',
      errorKind: 'invalid_output',
      latencyMs: 0,
      outputTokens: 4096,
    }),
    cell({
      model: 'a',
      outcome: 'schema',
      errorKind: 'invalid_output',
      latencyMs: 0,
      inputTokens: null,
    }),
    cell({ model: 'a', role: 'solver', think: true, latencyMs: 30_000, outputTokens: 2_000 }),
    cell({ model: 'b', latencyMs: 5_000 }),
    cell({ model: 'b', latencyMs: 6_000 }),
    cell({ model: 'b', outcome: 'provider', errorKind: 'network', latencyMs: 0 }),
  ];

  it('summarises per model, role and think mode', () => {
    const summary = summarise(cells);
    expect(summary.map((s) => [s.model, s.role, s.think, s.n])).toEqual([
      ['a', 'researcher', false, 4],
      ['a', 'solver', true, 1],
      ['b', 'researcher', false, 3],
    ]);
    const a = summary[0];
    expect(a).toMatchObject({
      validPct: 50,
      truncatedPct: 25,
      schemaPct: 25,
      providerPct: 0,
      linkValidPct: 50,
      medianLatencyMs: 4_000,
      p90LatencyMs: 12_000,
      medianOutputTokens: 300 + (4096 - 300) / 2 - (4096 - 300) / 2,
      cacheHits: 1,
    });
    expect(summary[2]).toMatchObject({ validPct: 66.7, providerPct: 33.3, linkValidPct: 100 });
  });

  it('ranks reliability first, then link validity, then speed', () => {
    const ranking = rankModels(cells);
    expect(ranking.map((r) => r.model)).toEqual(['b', 'a']);
    expect(ranking[0]).toMatchObject({ validPct: 66.7, linkValidPct: 100, n: 3 });
    expect(ranking[1]).toMatchObject({ validPct: 60, linkValidPct: 66.7, n: 5 });

    const tied = [
      cell({ model: 'fast', latencyMs: 1_000 }),
      cell({ model: 'slow', latencyMs: 9_000 }),
      cell({ model: 'linky', latencyMs: 500, linkProblems: 2 }),
    ];
    expect(rankModels(tied).map((r) => r.model)).toEqual(['fast', 'slow', 'linky']);
    expect(rankModels([]).length).toBe(0);
  });

  it('renders markdown tables', () => {
    const summary = renderSummaryTable(summarise(cells));
    expect(summary[0]).toMatch(/^\| Model \| Role \| Think \|/);
    expect(summary[2]).toBe(
      '| a | researcher | off | 4 | 50 | 25 | 25 | 0 | 50 | 4.0 | 12.0 | 300 | 1 |',
    );
    const ranking = renderRankingTable(rankModels(cells));
    expect(ranking[2]).toBe('| 1 | b | 66.7 | 100 | 5.0 | 3 |');
    expect(renderRankingTable(rankModels([cell({ outcome: 'schema' })]))[2]).toContain('| - |');
  });

  it('rotates the trigger targets per repetition and never returns an empty set', () => {
    const ids = ['a', 'b', 'c'];
    expect(targetVariant(ids, 0)).toEqual(['a', 'b', 'c']);
    expect(targetVariant(ids, 1)).toEqual(['a', 'b']);
    expect(targetVariant(ids, 2)).toEqual(['c']);
    expect(targetVariant(ids, 3)).toEqual(['c', 'b', 'a']);
    expect(targetVariant(ids, 4)).toEqual(['a', 'b', 'c']);
    expect(targetVariant(['only'], 2)).toEqual(['only']);
    expect(targetVariant([], 1)).toEqual([]);
  });
});
