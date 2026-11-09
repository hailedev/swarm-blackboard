import type { RunProfile } from '@team/core';
import type { BudgetResponse, StartRunBody } from '@team/server/api';

// The rules of the start-run dialog (docs/budget-guardrails.md §3, §5), as pure functions.
// They mirror what the server enforces so the dialog can say no before the request is
// sent; the server stays the authority, and its refusal is shown if the two ever differ.

export interface StartRunDraft {
  problem: string;
  /** One constraint per line. */
  constraints: string;
  /** One success criterion per line. */
  successCriteria: string;
  profile: string;
  maxCostUsd: string;
  maxRounds: string;
  /** The explicit yes a paid profile needs. */
  confirmed: boolean;
}

export type StartRunProblem =
  | { kind: 'no_problem' }
  | { kind: 'no_profile' }
  | { kind: 'bad_cap' }
  | { kind: 'bad_rounds' }
  /** The month cannot absorb this cap; `fitsCapUsd` is the largest cap that would fit. */
  | { kind: 'monthly_budget'; spentUsd: number; limitUsd: number; fitsCapUsd: number }
  | { kind: 'budget_unknown' }
  | { kind: 'unconfirmed' };

export interface StartRunCheck {
  paid: boolean;
  /** Everything that stops the run from starting; empty when it can. */
  problems: readonly StartRunProblem[];
  canStart: boolean;
}

const lines = (text: string): string[] =>
  text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');

const parseCap = (raw: string): number | undefined => {
  const value = Number(raw);
  return raw.trim() !== '' && Number.isFinite(value) && value >= 0 ? value : undefined;
};

const parseRounds = (raw: string): number | undefined => {
  const value = Number(raw);
  return raw.trim() !== '' && Number.isInteger(value) && value >= 1 ? value : undefined;
};

export const checkStartRun = (
  draft: StartRunDraft,
  profile: RunProfile | undefined,
  budget: BudgetResponse | undefined,
): StartRunCheck => {
  const problems: StartRunProblem[] = [];
  const paid = profile?.paid ?? false;
  if (draft.problem.trim() === '') problems.push({ kind: 'no_problem' });
  if (profile === undefined) problems.push({ kind: 'no_profile' });
  const cap = parseCap(draft.maxCostUsd);
  if (cap === undefined) problems.push({ kind: 'bad_cap' });
  if (parseRounds(draft.maxRounds) === undefined) problems.push({ kind: 'bad_rounds' });
  // Only a paid profile answers to the month: the free one spends nothing and is never refused.
  if (paid) {
    if (budget === undefined) {
      problems.push({ kind: 'budget_unknown' });
    } else if (cap !== undefined && budget.spentUsd + cap > budget.limitUsd) {
      problems.push({
        kind: 'monthly_budget',
        spentUsd: budget.spentUsd,
        limitUsd: budget.limitUsd,
        fitsCapUsd: Math.max(0, budget.limitUsd - budget.spentUsd),
      });
    }
    if (!draft.confirmed) problems.push({ kind: 'unconfirmed' });
  }
  return { paid, problems, canStart: problems.length === 0 };
};

/** The request body for a draft that passed `checkStartRun`; undefined when it did not. */
export const toStartRunBody = (draft: StartRunDraft): StartRunBody | undefined => {
  const maxCostUsd = parseCap(draft.maxCostUsd);
  const maxRounds = parseRounds(draft.maxRounds);
  if (maxCostUsd === undefined || maxRounds === undefined || draft.problem.trim() === '') {
    return undefined;
  }
  return {
    problem: {
      content: draft.problem.trim(),
      constraints: lines(draft.constraints),
      successCriteria: lines(draft.successCriteria),
    },
    profile: draft.profile,
    config: { maxCostUsd, maxRounds },
  };
};
