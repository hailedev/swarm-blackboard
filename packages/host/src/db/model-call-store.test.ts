import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CALIBRATION_SAFETY_FACTOR,
  isoFromMs,
  type Logger,
  type ModelCallTrace,
  nullLogger,
} from '@team/core';
import { SequentialIdGenerator, TEST_EPOCH_MS } from '@team/core/testing';
import { afterEach, describe, expect, it } from 'vitest';

import { importSpendJsonl } from './import-spend-jsonl';
import { ModelCallStore } from './model-call-store';
import { IN_MEMORY, openDatabase, type OpenedDatabase } from './open';
import { SqliteSpendLedger } from './sqlite-spend-ledger';

const opened: OpenedDatabase[] = [];
const tempDirs: string[] = [];
afterEach(async () => {
  for (const o of opened.splice(0)) o.close();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const setup = (logger: Logger = nullLogger) => {
  const o = openDatabase(IN_MEMORY);
  opened.push(o);
  const ids = new SequentialIdGenerator();
  return {
    db: o.db,
    ids,
    store: new ModelCallStore(o.db, { ids, logger }),
    ledger: new SqliteSpendLedger(o.db),
  };
};

const trace = (overrides: Partial<ModelCallTrace> = {}): ModelCallTrace => ({
  at: isoFromMs(TEST_EPOCH_MS),
  modelId: 'claude-haiku-5-5',
  billing: 'api',
  tags: { role: 'critic', runId: 'run-1', round: 3 },
  request: { system: 'sys', prompt: 'ask', maxOutputTokens: 512 },
  outcome: 'ok',
  usage: {
    inputTokens: 1_000,
    outputTokens: 100,
    cacheReadTokens: 200,
    cacheWriteTokens: 0,
    costUsd: 0.002,
  },
  estimate: { chars: 3_000, charsPerToken: 2, tokens: 1_500 },
  actualInputTokens: 1_200,
  warnings: ['unsupported setting: topK'],
  latencyMs: 350,
  response: { contributions: [] },
  error: null,
  ...overrides,
});

const usageWith = (costUsd: number) => ({
  inputTokens: 1_000,
  outputTokens: 100,
  cacheReadTokens: 200,
  cacheWriteTokens: 0,
  costUsd,
});

describe('ModelCallStore', () => {
  it('records a trace with every column and reads it back', () => {
    const { store } = setup();
    const id = store.record(trace());
    const row = store.byId(id);
    expect(row).toMatchObject({
      id,
      runId: 'run-1',
      round: 3,
      role: 'critic',
      modelId: 'claude-haiku-5-5',
      billing: 'api',
      at: isoFromMs(TEST_EPOCH_MS),
      outcome: 'ok',
      inputTokens: 1_000,
      outputTokens: 100,
      cacheReadTokens: 200,
      cacheWriteTokens: 0,
      costUsd: 0.002,
      estimateChars: 3_000,
      estimateCharsPerToken: 2,
      estimateTokens: 1_500,
      actualInputTokens: 1_200,
      latencyMs: 350,
      maxOutputTokens: 512,
      system: 'sys',
      prompt: 'ask',
      responseJson: '{"contributions":[]}',
      error: null,
      warningsJson: '["unsupported setting: topK"]',
      source: 'trace',
    });
    const [summary] = store.forRun('run-1');
    expect(summary).toBeDefined();
    expect(summary !== undefined && 'prompt' in summary).toBe(false);
    expect(summary?.costUsd).toBe(0.002);
    expect(store.forRun('other')).toEqual([]);
    expect(store.byId('nope')).toBeUndefined();
  });

  it('stores a failed call with null usage and the error text', () => {
    const { store } = setup();
    const id = store.record(
      trace({
        outcome: 'rate_limit',
        usage: null,
        actualInputTokens: null,
        response: null,
        error: '429',
      }),
    );
    expect(store.byId(id)).toMatchObject({
      outcome: 'rate_limit',
      inputTokens: null,
      costUsd: null,
      actualInputTokens: null,
      responseJson: 'null',
      error: '429',
    });
  });

  it('never lets a failed write escape the sink; it logs instead', () => {
    const errors: string[] = [];
    const logger: Logger = {
      ...nullLogger,
      error: (message) => {
        errors.push(message);
      },
    };
    const { store } = setup(logger);
    // An invalid trace (negative latency) fails validation before it reaches the table.
    expect(() => {
      store.sink(trace({ latencyMs: -1 }));
    }).not.toThrow();
    expect(errors).toEqual(['model call not recorded']);
    store.sink(trace());
    expect(store.forRun('run-1').length).toBe(1);
  });

  it('returns the newest fifty calibration samples of a model, oldest first, API-billed only', () => {
    const { store } = setup();
    for (let i = 0; i < 60; i += 1) {
      store.record(
        trace({
          at: isoFromMs(TEST_EPOCH_MS + i * 1_000),
          estimate: { chars: 2_000 + i, charsPerToken: 2, tokens: 1_000 },
          actualInputTokens: 1_000,
        }),
      );
    }
    // Not samples: a local call, a call with no reported count, another model.
    store.record(
      trace({
        billing: 'local',
        modelId: 'claude-haiku-5-5',
        at: isoFromMs(TEST_EPOCH_MS + 90_000),
      }),
    );
    store.record(trace({ actualInputTokens: null, at: isoFromMs(TEST_EPOCH_MS + 91_000) }));
    store.record(trace({ modelId: 'claude-sonnet-5-5', at: isoFromMs(TEST_EPOCH_MS + 92_000) }));
    const samples = store.calibrationSamples('claude-haiku-5-5');
    expect(samples.length).toBe(50);
    expect(samples[0]).toEqual({ chars: 2_010, tokens: 1_000 });
    expect(samples.at(-1)).toEqual({ chars: 2_059, tokens: 1_000 });
    expect(store.calibrationSamples('claude-haiku-5-5', 5).length).toBe(5);
    expect(store.calibrationSamples('claude-sonnet-5-5')).toEqual([
      { chars: 3_000, tokens: 1_200 },
    ]);
  });

  it('calibrates paid models from their samples and leaves local models to the provider default', () => {
    const { store } = setup();
    const haiku = { alias: 'haiku', provider: 'anthropic' as const, model: 'claude-haiku-5-5' };
    const local = { alias: 'local', provider: 'ollama' as const, model: 'qwen3.6:35b-a3b-q8_0' };
    // Too few samples: the provider default stands.
    expect(store.charsPerToken(haiku, 2)).toBe(2);
    for (let i = 0; i < 5; i += 1) {
      store.record(
        trace({
          at: isoFromMs(TEST_EPOCH_MS + i),
          estimate: { chars: 3_000, charsPerToken: 2, tokens: 1_500 },
          actualInputTokens: 1_000,
        }),
      );
    }
    expect(store.charsPerToken(haiku, 2)).toBeCloseTo(3 / CALIBRATION_SAFETY_FACTOR, 3);
    for (let i = 0; i < 5; i += 1) {
      store.record(
        trace({ billing: 'local', modelId: local.model, at: isoFromMs(TEST_EPOCH_MS + i) }),
      );
    }
    expect(store.charsPerToken(local, 3)).toBeUndefined();
  });
});

describe('SqliteSpendLedger', () => {
  it('sums API-billed calls inside the period, end exclusive, and nothing else', async () => {
    const { store, ledger } = setup();
    const period = { start: '2026-01-01T00:00:00.000Z', end: '2026-02-01T00:00:00.000Z' };
    store.record(trace({ at: '2025-12-31T23:59:59.999Z', usage: usageWith(1) }));
    store.record(trace({ at: '2026-01-01T00:00:00.000Z', usage: usageWith(0.5) }));
    store.record(trace({ at: '2026-01-20T12:00:00.000Z', usage: usageWith(0.25) }));
    store.record(trace({ at: '2026-02-01T00:00:00.000Z', usage: usageWith(1) }));
    store.record(
      trace({
        at: '2026-01-10T00:00:00.000Z',
        billing: 'local',
        usage: usageWith(0),
      }),
    );
    store.record(
      trace({
        at: '2026-01-11T00:00:00.000Z',
        billing: 'fake',
        usage: usageWith(9),
      }),
    );
    store.record(
      trace({
        at: '2026-01-12T00:00:00.000Z',
        outcome: 'auth',
        usage: null,
        actualInputTokens: null,
        response: null,
        error: 'bad key',
      }),
    );
    expect(await ledger.spentUsd(period)).toBeCloseTo(0.75, 10);
    expect(
      await ledger.spentUsd({ start: '2027-01-01T00:00:00.000Z', end: '2027-02-01T00:00:00.000Z' }),
    ).toBe(0);
  });
});

describe('importSpendJsonl', () => {
  it('takes the JSONL ledger into model_calls once, so the month survives the move', async () => {
    const { db, ids, ledger } = setup();
    const dir = await mkdtemp(join(tmpdir(), 'swarm-ledger-'));
    tempDirs.push(dir);
    const file = join(dir, 'spend.jsonl');
    const record = (at: string, costUsd: number) =>
      JSON.stringify({
        at,
        runId: 'run-old',
        role: 'planner',
        modelId: 'claude-haiku-5-5',
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd,
      });
    await writeFile(
      file,
      `${record('2026-01-05T00:00:00.000Z', 0.01)}\n\n${record('2026-01-06T00:00:00.000Z', 0.02)}\n`,
    );
    expect(await importSpendJsonl(file, db, ids)).toEqual({ imported: 2, skipped: 0 });
    expect(await importSpendJsonl(file, db, ids)).toEqual({ imported: 0, skipped: 2 });
    expect(
      await ledger.spentUsd({ start: '2026-01-01T00:00:00.000Z', end: '2026-02-01T00:00:00.000Z' }),
    ).toBeCloseTo(0.03, 10);

    await writeFile(join(dir, 'bad.jsonl'), '{"at":"nope"}\n');
    await expect(importSpendJsonl(join(dir, 'bad.jsonl'), db, ids)).rejects.toThrow(
      /bad\.jsonl:1: /,
    );
  });
});
