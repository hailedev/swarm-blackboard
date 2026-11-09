import { AgentFailureReasonSchema, RunEndReasonSchema, type RunProfile } from '@team/core';
import type { BudgetResponse } from '@team/server/api';
import { describe, expect, it } from 'vitest';

import { compact, duration, excerpt, percent, usd } from './format';
import { fractionOf, GAUGE_LEVEL_LABEL, gaugeLevel } from './gauge';
import { FAILURE_LABEL, REASON_TEXT, STATUS_LABEL } from './reasons';
import { checkStartRun, toStartRunBody, type StartRunDraft } from './start-run';
import { hashForRun, runIdFromHash } from './use-hash-route';

describe('format', () => {
  it('formats money, shares, counts and durations the way the meters print them', () => {
    expect(usd(0.02377059)).toBe('$0.0238');
    expect(usd(5, 2)).toBe('$5.00');
    expect(percent(0.126)).toBe('13%');
    expect(percent(1)).toBe('100%');
    expect([950, 1_500, 12_940, 154_447, 400_000, 1_250_000].map(compact)).toEqual([
      '950',
      '1.5K',
      '12.9K',
      '154K',
      '400K',
      '1.3M',
    ]);
    expect([0, 42_000, 185_000, 900_000, 3_720_000, -5].map(duration)).toEqual([
      '0s',
      '42s',
      '3m 05s',
      '15m 00s',
      '1h 02m',
      '0s',
    ]);
  });

  it('cuts a long text to one line', () => {
    expect(excerpt('  two\n lines  ', 20)).toBe('two lines');
    expect(excerpt('abcdefghij', 6)).toBe('abcde…');
  });
});

describe('gauge', () => {
  it('turns amber at the warning fraction and red at the limit', () => {
    expect([0, 0.79, 0.8, 0.99, 1, 1.4].map((f) => gaugeLevel(f))).toEqual([
      'ok',
      'ok',
      'warning',
      'warning',
      'over',
      'over',
    ]);
    // The month's gauge takes its warning fraction from the server.
    expect(gaugeLevel(0.6, 0.5)).toBe('warning');
    expect(gaugeLevel(0.4, 0.5)).toBe('ok');
    expect(Object.keys(GAUGE_LEVEL_LABEL).sort()).toEqual(['ok', 'over', 'warning']);
  });

  it('measures a value against its limit, and treats a zero limit as spent by anything', () => {
    expect(fractionOf(0.2, 0.25)).toBeCloseTo(0.8, 10);
    expect(fractionOf(0, 0)).toBe(0);
    expect(fractionOf(0.01, 0)).toBe(1);
  });
});

describe('reasons', () => {
  it('has words for every reason a run can stop for and every way an agent can fail', () => {
    for (const reason of RunEndReasonSchema.options) {
      expect(REASON_TEXT[reason].label).not.toBe('');
      expect(REASON_TEXT[reason].detail.endsWith('.')).toBe(true);
    }
    expect(Object.keys(REASON_TEXT).sort()).toEqual([...RunEndReasonSchema.options].sort());
    expect(Object.keys(FAILURE_LABEL).sort()).toEqual([...AgentFailureReasonSchema.options].sort());
    expect(Object.keys(STATUS_LABEL).sort()).toEqual(
      ['completed', 'failed', 'paused', 'running', 'stopped'].sort(),
    );
  });

  it('tells a resumable pause what to do next', () => {
    for (const reason of [
      'rate_limit',
      'provider_unreachable',
      'user_paused',
      'interrupted',
    ] as const) {
      expect(REASON_TEXT[reason].detail).toContain('Resume');
    }
    expect(REASON_TEXT.monthly_budget.detail).toContain('Resume next month');
  });
});

const local = { alias: 'local-fast', provider: 'ollama', model: 'qwen3.6:35b-mlx' } as const;
const haiku = { alias: 'haiku', provider: 'anthropic', model: 'claude-haiku-5-5' } as const;

const dev: RunProfile = {
  name: 'dev',
  roles: { planner: local, researcher: local, solver: local, critic: local, synthesizer: local },
  bidder: local,
  fallback: null,
  paid: false,
};

const cheap: RunProfile = {
  name: 'cheap',
  roles: { planner: haiku, researcher: local, solver: local, critic: haiku, synthesizer: haiku },
  bidder: haiku,
  fallback: haiku,
  paid: true,
};

const budget = (spentUsd: number): BudgetResponse => ({
  period: { start: '2026-11-01T00:00:00.000Z', end: '2026-12-01T00:00:00.000Z' },
  spentUsd,
  limitUsd: 5,
  warnAtFraction: 0.8,
  timeZone: 'UTC',
});

const draft = (overrides: Partial<StartRunDraft> = {}): StartRunDraft => ({
  problem: 'Should we adopt a monorepo?',
  constraints: '',
  successCriteria: '',
  profile: 'dev',
  maxCostUsd: '0.25',
  maxRounds: '12',
  confirmed: false,
  ...overrides,
});

const kinds = (check: ReturnType<typeof checkStartRun>): string[] =>
  check.problems.map((problem) => problem.kind);

describe('checkStartRun', () => {
  it('lets a free profile start with no confirmation and whatever the month has spent', () => {
    expect(checkStartRun(draft(), dev, budget(4.99))).toEqual({
      paid: false,
      problems: [],
      canStart: true,
    });
    // Not even an unread budget holds a free run back.
    expect(checkStartRun(draft(), dev, undefined).canStart).toBe(true);
  });

  it('asks a paid profile for an explicit yes', () => {
    const unconfirmed = checkStartRun(draft({ profile: 'cheap' }), cheap, budget(0));
    expect(unconfirmed).toMatchObject({ paid: true, canStart: false });
    expect(kinds(unconfirmed)).toEqual(['unconfirmed']);
    expect(
      checkStartRun(draft({ profile: 'cheap', confirmed: true }), cheap, budget(0)).canStart,
    ).toBe(true);
  });

  it('refuses a paid run the month cannot absorb, and says what cap would fit', () => {
    const check = checkStartRun(draft({ profile: 'cheap', confirmed: true }), cheap, budget(4.9));
    expect(check.canStart).toBe(false);
    const refusal = check.problems.find((p) => p.kind === 'monthly_budget');
    expect(refusal).toMatchObject({ spentUsd: 4.9, limitUsd: 5 });
    expect(refusal?.kind === 'monthly_budget' && refusal.fitsCapUsd).toBeCloseTo(0.1, 10);
    // Exactly at the limit still fits, as it does on the server (spent + cap > limit refuses).
    expect(
      checkStartRun(draft({ profile: 'cheap', confirmed: true }), cheap, budget(4.75)).canStart,
    ).toBe(true);
    // A month already over its limit leaves nothing: the cap that fits is zero, not negative.
    const over = checkStartRun(draft({ profile: 'cheap', confirmed: true }), cheap, budget(6));
    const none = over.problems.find((p) => p.kind === 'monthly_budget');
    expect(none?.kind === 'monthly_budget' && none.fitsCapUsd).toBe(0);
    // Until the month's figure is read, a paid run cannot be checked, so it cannot start.
    expect(
      kinds(checkStartRun(draft({ profile: 'cheap', confirmed: true }), cheap, undefined)),
    ).toEqual(['budget_unknown']);
  });

  it('wants a problem, a known profile, a sane cap and a whole number of rounds', () => {
    expect(kinds(checkStartRun(draft({ problem: '   ' }), dev, budget(0)))).toEqual(['no_problem']);
    expect(kinds(checkStartRun(draft(), undefined, budget(0)))).toEqual(['no_profile']);
    for (const maxCostUsd of ['', 'abc', '-1']) {
      expect(kinds(checkStartRun(draft({ maxCostUsd }), dev, budget(0)))).toEqual(['bad_cap']);
    }
    for (const maxRounds of ['', '0', '2.5', 'twelve']) {
      expect(kinds(checkStartRun(draft({ maxRounds }), dev, budget(0)))).toEqual(['bad_rounds']);
    }
    expect(checkStartRun(draft({ maxCostUsd: '0' }), dev, budget(0)).canStart).toBe(true);
  });
});

describe('toStartRunBody', () => {
  it('builds the request the server validates', () => {
    expect(
      toStartRunBody(
        draft({
          problem: '  Which database?  ',
          constraints: 'four people\n\n  no new infrastructure ',
          successCriteria: 'a recommendation',
          profile: 'cheap',
          maxCostUsd: '0.1',
          maxRounds: '6',
        }),
      ),
    ).toEqual({
      problem: {
        content: 'Which database?',
        constraints: ['four people', 'no new infrastructure'],
        successCriteria: ['a recommendation'],
      },
      profile: 'cheap',
      config: { maxCostUsd: 0.1, maxRounds: 6 },
    });
    expect(toStartRunBody(draft({ maxRounds: 'x' }))).toBeUndefined();
    expect(toStartRunBody(draft({ problem: '' }))).toBeUndefined();
  });
});

describe('the run route', () => {
  it('reads a run id from the fragment and writes it back', () => {
    expect(runIdFromHash('#/runs/01a1bf11-d833-7265-a5e1-99a744748296')).toBe(
      '01a1bf11-d833-7265-a5e1-99a744748296',
    );
    expect(runIdFromHash(hashForRun('a b/c'))).toBe('a b/c');
    expect(runIdFromHash('')).toBeNull();
    expect(runIdFromHash('#/')).toBeNull();
    expect(runIdFromHash('#/runs/')).toBeNull();
    expect(runIdFromHash('#/runs/a/b')).toBeNull();
    expect(hashForRun(null)).toBe('#/');
  });
});
