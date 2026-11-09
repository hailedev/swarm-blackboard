import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { SpendRecordSchema, type Period, type SpendLedger, type SpendRecord } from '@team/core';
import type { ModelCallTrace } from '@team/providers';

const isMissingFile = (cause: unknown): boolean =>
  typeof cause === 'object' &&
  cause !== null &&
  'code' in cause &&
  (cause as { code?: unknown }).code === 'ENOENT';

// Append-only JSONL ledger of paid calls (docs/budget-guardrails.md §3, Phase 2). One
// JSON object per line; the month-to-date figure is a sum over the lines in the period.
// Phase 3 replaces it with a SUM over model_calls behind the same interface.
export class JsonlSpendLedger implements SpendLedger {
  readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  async spentUsd(period: Period): Promise<number> {
    const start = Date.parse(period.start);
    const end = Date.parse(period.end);
    let total = 0;
    for (const record of await this.readAll()) {
      const at = Date.parse(record.at);
      if (at >= start && at < end) total += record.costUsd;
    }
    return total;
  }

  async record(record: SpendRecord): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, `${JSON.stringify(record)}\n`, 'utf8');
  }

  async readAll(): Promise<SpendRecord[]> {
    let text: string;
    try {
      text = await readFile(this.path, 'utf8');
    } catch (cause) {
      if (isMissingFile(cause)) return [];
      throw cause;
    }
    return text
      .split('\n')
      .map((line, index) => ({ line: line.trim(), lineNo: index + 1 }))
      .filter(({ line }) => line !== '')
      .map(({ line, lineNo }) => {
        const parsed = SpendRecordSchema.safeParse(JSON.parse(line));
        if (!parsed.success) {
          const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
          throw new Error(`${this.path}:${String(lineNo)}: ${issues.join('; ')}`);
        }
        return parsed.data;
      });
  }
}

/** Only API calls that produced billable tokens reach the ledger. */
export const spendRecordFromTrace = (trace: ModelCallTrace): SpendRecord | null =>
  trace.billing === 'api' && trace.usage !== null
    ? {
        at: trace.at,
        runId: trace.tags.runId,
        role: trace.tags.role,
        modelId: trace.modelId,
        ...trace.usage,
      }
    : null;
