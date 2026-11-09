import { err, ok, type Result } from '@team/core';

export type Env = Readonly<Record<string, string | undefined>>;

export interface MonthlyBudgetSettings {
  limitUsd: number;
  warnAtFraction: number;
  timeZone: string;
}

// docs/budget-guardrails.md §6. The time zone decides where calendar months start.
export const DEFAULT_MONTHLY_BUDGET: MonthlyBudgetSettings = {
  limitUsd: 5,
  warnAtFraction: 0.8,
  timeZone: 'Australia/Sydney',
};

const number = (
  env: Env,
  name: string,
  fallback: number,
  valid: (n: number) => boolean,
): Result<number, string> => {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return ok(fallback);
  const parsed = Number(raw);
  return Number.isFinite(parsed) && valid(parsed)
    ? ok(parsed)
    : err(`${name} must be a valid number, got "${raw}"`);
};

export const monthlyBudgetFromEnv = (env: Env): Result<MonthlyBudgetSettings, string> => {
  const limit = number(env, 'MONTHLY_BUDGET_USD', DEFAULT_MONTHLY_BUDGET.limitUsd, (n) => n >= 0);
  if (!limit.ok) return limit;
  const warnAt = number(
    env,
    'MONTHLY_BUDGET_WARN_AT',
    DEFAULT_MONTHLY_BUDGET.warnAtFraction,
    (n) => n >= 0 && n <= 1,
  );
  if (!warnAt.ok) return err(`${warnAt.error} (a fraction between 0 and 1)`);
  const timeZone = env['BUDGET_TIMEZONE']?.trim();
  return ok({
    limitUsd: limit.value,
    warnAtFraction: warnAt.value,
    timeZone:
      timeZone === undefined || timeZone === '' ? DEFAULT_MONTHLY_BUDGET.timeZone : timeZone,
  });
};
