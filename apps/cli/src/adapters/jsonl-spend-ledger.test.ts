import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ModelCallTrace } from '@team/providers';
import { afterEach, describe, expect, it } from 'vitest';

import { JsonlSpendLedger, spendRecordFromTrace } from './jsonl-spend-ledger';

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const tempPath = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'swarm-ledger-'));
  tempDirs.push(dir);
  return join(dir, 'nested', 'spend.jsonl');
};

const usage = (costUsd: number) => ({
  inputTokens: 100,
  outputTokens: 10,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd,
});

const record = (at: string, costUsd: number) => ({
  at,
  runId: 'run-1',
  role: 'critic',
  modelId: 'claude-haiku-5-5',
  ...usage(costUsd),
});

const january = { start: '2026-01-01T00:00:00.000Z', end: '2026-02-01T00:00:00.000Z' };

describe('JsonlSpendLedger', () => {
  it('reads an absent ledger as zero spend', async () => {
    const ledger = new JsonlSpendLedger(await tempPath());
    expect(await ledger.spentUsd(january)).toBe(0);
  });

  it('appends one line per call, creating the directory, and sums only the period', async () => {
    const path = await tempPath();
    const ledger = new JsonlSpendLedger(path);
    await ledger.record(record('2025-12-31T23:59:59.999Z', 1));
    await ledger.record(record('2026-01-01T00:00:00.000Z', 0.25));
    await ledger.record(record('2026-01-20T10:00:00.000Z', 0.5));
    await ledger.record(record('2026-02-01T00:00:00.000Z', 2));

    expect(await ledger.spentUsd(january)).toBeCloseTo(0.75, 10);
    const lines = (await readFile(path, 'utf8')).trim().split('\n');
    expect(lines.length).toBe(4);
    expect(JSON.parse(lines[1] ?? '')).toEqual(record('2026-01-01T00:00:00.000Z', 0.25));
  });

  it('refuses a corrupt line with its number instead of silently under-counting', async () => {
    const path = await tempPath();
    const ledger = new JsonlSpendLedger(path);
    await ledger.record(record('2026-01-02T00:00:00.000Z', 0.1));
    await writeFile(
      path,
      `${JSON.stringify(record('2026-01-02T00:00:00.000Z', 0.1))}\n{"at":"2026-01-03T00:00:00.000Z"}\n`,
    );
    await expect(ledger.spentUsd(january)).rejects.toThrow(/spend\.jsonl:2: /);
  });
});

describe('spendRecordFromTrace', () => {
  const trace = (
    billing: ModelCallTrace['billing'],
    usageOrNull: ModelCallTrace['usage'],
  ): ModelCallTrace => ({
    at: '2026-01-05T00:00:00.000Z',
    modelId: 'claude-haiku-5-5',
    billing,
    tags: { role: 'critic', runId: 'run-1', round: 3 },
    request: { system: 's', prompt: 'p', maxOutputTokens: 512 },
    outcome: 'ok',
    usage: usageOrNull,
    estimate: { chars: 3003, charsPerToken: 3, tokens: 1001 },
    actualInputTokens: usageOrNull === null ? null : usageOrNull.inputTokens,
    warnings: [],
    latencyMs: 10,
    response: {},
    error: null,
  });

  it('turns a billed API call into a ledger record and ignores everything else', () => {
    expect(spendRecordFromTrace(trace('api', usage(0.002)))).toEqual(
      record('2026-01-05T00:00:00.000Z', 0.002),
    );
    expect(spendRecordFromTrace(trace('local', usage(0)))).toBeNull();
    expect(spendRecordFromTrace(trace('fake', usage(0.002)))).toBeNull();
    expect(spendRecordFromTrace(trace('api', null))).toBeNull();
  });
});
