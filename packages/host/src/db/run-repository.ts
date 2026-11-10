import {
  RunConfigSchema,
  RunEndReasonSchema,
  RunStatusSchema,
  type RunConfig,
  type RunEndReason,
  type RunTotals,
} from '@team/core';
import { desc, eq } from 'drizzle-orm';
import { z } from 'zod';

import type { Db } from './open';
import { runs } from './schema';

/** A run as stored: `running` while the controller loop owns it, else a core RunStatus. */
export const StoredRunStatusSchema = z.enum(['running', ...RunStatusSchema.options]);
export type StoredRunStatus = z.infer<typeof StoredRunStatusSchema>;

export interface RunRecord {
  id: string;
  problem: string;
  status: StoredRunStatus;
  reason: RunEndReason | null;
  profileName: string | null;
  config: RunConfig;
  startedAt: string;
  endedAt: string | null;
  totals: RunTotals;
}

const toRecord = (row: typeof runs.$inferSelect): RunRecord => ({
  id: row.id,
  problem: row.problemContent,
  status: StoredRunStatusSchema.parse(row.status),
  reason: row.reason === null ? null : RunEndReasonSchema.parse(row.reason),
  profileName: row.profileName,
  config: RunConfigSchema.parse(JSON.parse(row.configJson)),
  startedAt: row.startedAt,
  endedAt: row.endedAt,
  totals: {
    rounds: row.rounds,
    entries: row.entries,
    elapsedMs: row.elapsedMs,
    usage: {
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      cacheReadTokens: row.cacheReadTokens,
      cacheWriteTokens: row.cacheWriteTokens,
      reasoningTokens: row.reasoningTokens,
      costUsd: row.costUsd,
    },
  },
});

/** Reads the materialised `runs` table; the event log stays the source of truth. */
export class RunRepository {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  /** Newest first. */
  list(): RunRecord[] {
    return this.#db
      .select()
      .from(runs)
      .orderBy(desc(runs.startedAt), desc(runs.id))
      .all()
      .map(toRecord);
  }

  get(id: string): RunRecord | undefined {
    const row = this.#db.select().from(runs).where(eq(runs.id, id)).get();
    return row === undefined ? undefined : toRecord(row);
  }
}
