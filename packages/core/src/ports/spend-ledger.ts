// Month-to-date spend lives outside core (docs/budget-guardrails.md §3). Phase 2 backs
// it with a JSONL file in the CLI; Phase 3 with the model_calls table. Core only sums.

/** Half-open interval of ISO-8601 instants: start inclusive, end exclusive. */
export interface Period {
  start: string;
  end: string;
}

export interface SpendLedger {
  spentUsd(period: Period): Promise<number>;
}

export interface PeriodBudget {
  /** MONTHLY_BUDGET_USD */
  limitUsd: number;
  /** Fraction of the limit at which a single `budget_warning` is emitted per run. */
  warnAtFraction: number;
  /** IANA time zone whose calendar months bound the period. */
  timeZone: string;
  ledger: SpendLedger;
}
