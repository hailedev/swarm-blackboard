import type { Period, SpendLedger } from '../ports/spend-ledger';

// A ledger whose month-to-date figure the test sets directly. Records every period it
// was asked about so tests can assert the controller re-reads it before each round.
export class FakeSpendLedger implements SpendLedger {
  spent: number;
  readonly periods: Period[] = [];

  constructor(spentUsd = 0) {
    this.spent = spentUsd;
  }

  spentUsd(period: Period): Promise<number> {
    this.periods.push(period);
    return Promise.resolve(this.spent);
  }
}
