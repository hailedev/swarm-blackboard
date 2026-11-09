import type { Period, SpendLedger } from '@team/core';
import { and, eq, gte, lt, sql } from 'drizzle-orm';

import type { Db } from './open';
import { modelCalls } from './schema';

// The monthly ledger (docs/budget-guardrails.md §3, ADR-0010): what the API billed in a
// period, summed over every call this machine recorded, from whichever host made it.
// Period bounds and `at` are both ISO-8601 UTC strings, so text comparison orders them.
export class SqliteSpendLedger implements SpendLedger {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  spentUsd(period: Period): Promise<number> {
    const row = this.#db
      .select({ total: sql<number>`coalesce(sum(${modelCalls.costUsd}), 0)` })
      .from(modelCalls)
      .where(
        and(
          eq(modelCalls.billing, 'api'),
          gte(modelCalls.at, period.start),
          lt(modelCalls.at, period.end),
        ),
      )
      .get();
    return Promise.resolve(row?.total ?? 0);
  }
}
