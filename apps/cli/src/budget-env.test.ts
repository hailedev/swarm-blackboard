import { describe, expect, it } from 'vitest';

import { DEFAULT_MONTHLY_BUDGET, monthlyBudgetFromEnv } from './budget-env';

describe('monthlyBudgetFromEnv', () => {
  it('defaults to $5, 80% and Sydney calendar months', () => {
    expect(monthlyBudgetFromEnv({})).toEqual({ ok: true, value: DEFAULT_MONTHLY_BUDGET });
    expect(monthlyBudgetFromEnv({ MONTHLY_BUDGET_USD: '', BUDGET_TIMEZONE: ' ' })).toEqual({
      ok: true,
      value: DEFAULT_MONTHLY_BUDGET,
    });
  });

  it('reads the three settings', () => {
    expect(
      monthlyBudgetFromEnv({
        MONTHLY_BUDGET_USD: '12.5',
        MONTHLY_BUDGET_WARN_AT: '0.5',
        BUDGET_TIMEZONE: 'UTC',
      }),
    ).toEqual({ ok: true, value: { limitUsd: 12.5, warnAtFraction: 0.5, timeZone: 'UTC' } });
  });

  it.each([
    ['MONTHLY_BUDGET_USD', 'five'],
    ['MONTHLY_BUDGET_USD', '-1'],
    ['MONTHLY_BUDGET_WARN_AT', '80'],
    ['MONTHLY_BUDGET_WARN_AT', 'most'],
  ])('rejects a bad %s of "%s"', (name, raw) => {
    const result = monthlyBudgetFromEnv({ [name]: raw });
    expect(!result.ok && result.error).toContain(name);
  });
});
