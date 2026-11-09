import { readFile } from 'node:fs/promises';

import { SpendRecordSchema, type IdGenerator } from '@team/core';
import { and, eq } from 'drizzle-orm';

import type { Db } from './open';
import { modelCalls } from './schema';

export interface SpendImportReport {
  imported: number;
  /** Rows already present from an earlier import. */
  skipped: number;
}

/**
 * One-shot import of the Phase 2 JSONL ledger (`data/spend.jsonl`) into `model_calls`
 * as `source = 'import'` rows, so the month's spend survives the move to one ledger
 * (ADR-0010). Running it twice imports nothing new.
 */
export const importSpendJsonl = async (
  path: string,
  db: Db,
  ids: IdGenerator,
): Promise<SpendImportReport> => {
  const text = await readFile(path, 'utf8');
  const records = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .map((line, index) => {
      const parsed = SpendRecordSchema.safeParse(JSON.parse(line));
      if (!parsed.success) {
        const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
        throw new Error(`${path}:${String(index + 1)}: ${issues.join('; ')}`);
      }
      return parsed.data;
    });
  const report: SpendImportReport = { imported: 0, skipped: 0 };
  db.transaction((tx) => {
    for (const record of records) {
      const existing = tx
        .select({ id: modelCalls.id })
        .from(modelCalls)
        .where(
          and(
            eq(modelCalls.source, 'import'),
            eq(modelCalls.at, record.at),
            eq(modelCalls.runId, record.runId),
            eq(modelCalls.role, record.role),
            eq(modelCalls.modelId, record.modelId),
          ),
        )
        .get();
      if (existing !== undefined) {
        report.skipped += 1;
        continue;
      }
      tx.insert(modelCalls)
        .values({
          id: ids.next(),
          runId: record.runId,
          round: null,
          role: record.role,
          modelId: record.modelId,
          billing: 'api',
          at: record.at,
          outcome: 'ok',
          inputTokens: record.inputTokens,
          outputTokens: record.outputTokens,
          cacheReadTokens: record.cacheReadTokens,
          cacheWriteTokens: record.cacheWriteTokens,
          costUsd: record.costUsd,
          source: 'import',
        })
        .run();
      report.imported += 1;
    }
  });
  return report;
};
