import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BoardEventSchema,
  buildBoardView,
  createController,
  createDefaultAgents,
  nullLogger,
  type BoardEvent,
  type Controller,
} from '@team/core';
import {
  createScriptedModels,
  ManualClock,
  SequentialIdGenerator,
  testRolePrompts,
} from '@team/core/testing';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { databasePathFromUrl, IN_MEMORY, openDatabase, type OpenedDatabase } from './open';
import { agentConfigs, entries, runs } from './schema';
import { SqliteBoardStore } from './sqlite-board-store';

const FIXTURE = fileURLToPath(
  new URL(
    '../../../../fixtures/runs/2026-11-09-cheap-release-process/events.json',
    import.meta.url,
  ),
);

const opened: OpenedDatabase[] = [];
const tempDirs: string[] = [];
afterEach(async () => {
  for (const o of opened.splice(0)) o.close();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const memory = (): OpenedDatabase => {
  const o = openDatabase(IN_MEMORY);
  opened.push(o);
  return o;
};

// The CLI's --fake run: scripted models, the default roster, four rounds to `completed`.
const scriptedRun = async (store: SqliteBoardStore) => {
  const events: BoardEvent[] = [];
  const ref: { controller: Controller | undefined } = { controller: undefined };
  const models = createScriptedModels(() => {
    if (ref.controller === undefined) throw new Error('controller not ready');
    return ref.controller.currentView();
  });
  const controller = createController({
    store,
    clock: new ManualClock(),
    ids: new SequentialIdGenerator(),
    logger: nullLogger,
    agents: createDefaultAgents(models, testRolePrompts()),
    onEvent: (event) => events.push(event),
  });
  ref.controller = controller;
  const started = await controller.start({ content: 'Should we adopt a monorepo?' });
  if (!started.ok) throw new Error(JSON.stringify(started.error));
  const result = await controller.run();
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return { controller, events, summary: result.value };
};

describe('databasePathFromUrl', () => {
  it('strips the file: scheme and passes :memory: and plain paths through', () => {
    expect(databasePathFromUrl('file:./data/team.db')).toBe('./data/team.db');
    expect(databasePathFromUrl(' file:/abs/team.db ')).toBe('/abs/team.db');
    expect(databasePathFromUrl(':memory:')).toBe(IN_MEMORY);
    expect(databasePathFromUrl('')).toBe(IN_MEMORY);
    expect(databasePathFromUrl('file:')).toBe(IN_MEMORY);
    expect(databasePathFromUrl('data/x.db')).toBe('data/x.db');
  });
});

describe('SqliteBoardStore', () => {
  it('replays a scripted run exactly and materialises runs and entries', async () => {
    const { db } = memory();
    const store = new SqliteBoardStore(db);
    const { controller, events, summary } = await scriptedRun(store);
    expect(summary.reason).toBe('completed');

    const replayed = await store.eventsFor(controller.runId);
    expect(replayed).toEqual(events);
    const view = buildBoardView(controller.runId, replayed);
    const live = controller.currentView();
    expect(view.entries).toEqual(live.entries);
    expect(view.live.map((e) => e.id)).toEqual(live.live.map((e) => e.id));
    expect(view.round).toBe(live.round);
    expect(view.lastEntryRound).toBe(live.lastEntryRound);
    for (const entry of live.entries) expect(view.handleOf(entry.id)).toBe(live.handleOf(entry.id));

    const rows = db.select().from(entries).where(eq(entries.runId, controller.runId)).all();
    expect(rows.map((r) => r.id)).toEqual(live.entries.map((e) => e.id));
    expect(rows.map((r) => r.handle)).toEqual(live.entries.map((e) => live.handleOf(e.id)));
    expect(rows.map((r) => [r.type, r.round, r.author, r.supersedes ?? undefined])).toEqual(
      live.entries.map((e) => [e.type, e.round, e.author, e.supersedes]),
    );
    const first = rows[0];
    expect(first?.parentsJson).toBe('[]');
    expect(JSON.parse(first?.payloadJson ?? '{}')).toEqual(live.entries[0]?.payload);

    const run = db.select().from(runs).where(eq(runs.id, controller.runId)).get();
    expect(run).toMatchObject({
      status: 'completed',
      reason: 'completed',
      profileName: null,
      rounds: 4,
      entries: live.entries.length,
      problemContent: 'Should we adopt a monorepo?',
    });
    expect(run?.costUsd).toBeCloseTo(summary.totals.usage.costUsd, 10);
    expect(run?.inputTokens).toBe(summary.totals.usage.inputTokens);
    expect(run?.endedAt).toBe(events.at(-1)?.at);
    expect(JSON.parse(run?.configJson ?? '{}')).toMatchObject({ maxRounds: 12 });
    expect(await store.eventsFor('nope')).toEqual([]);
  });

  it('round-trips the recorded first real run and stores its profile', async () => {
    const { db } = memory();
    const store = new SqliteBoardStore(db);
    const recorded = z.array(BoardEventSchema).parse(JSON.parse(readFileSync(FIXTURE, 'utf8')));
    for (const event of recorded) {
      const appended = await store.append(event);
      expect(appended.ok, JSON.stringify(appended)).toBe(true);
    }
    const runId = recorded[0]?.runId ?? '';
    expect(await store.eventsFor(runId)).toEqual(recorded);

    const fromLog = buildBoardView(runId, recorded);
    const rows = db.select().from(entries).where(eq(entries.runId, runId)).all();
    expect(rows.map((r) => r.handle)).toEqual(fromLog.entries.map((e) => fromLog.handleOf(e.id)));

    const started = recorded[0];
    const ended = recorded.at(-1);
    if (started?.type !== 'run_started' || ended?.type !== 'run_terminated') {
      throw new Error('fixture shape changed');
    }
    expect(db.select().from(runs).where(eq(runs.id, runId)).get()).toMatchObject({
      status: ended.status,
      reason: ended.reason,
      profileName: started.profile?.name,
      rounds: ended.totals.rounds,
      entries: ended.totals.entries,
      costUsd: ended.totals.usage.costUsd,
    });
    const configs = db.select().from(agentConfigs).where(eq(agentConfigs.runId, runId)).all();
    const profile = started.profile;
    if (profile === null) throw new Error('fixture has no profile');
    expect(configs.length).toBe(
      5 + (profile.bidder === null ? 0 : 1) + (profile.fallback === null ? 0 : 1),
    );
    expect(configs.find((c) => c.kind === 'role' && c.role === 'researcher')).toMatchObject({
      provider: 'ollama',
      alias: 'local',
      think: false,
    });
    expect(configs.find((c) => c.kind === 'fallback')).toMatchObject({
      role: null,
      model: 'claude-haiku-5-5',
    });
  });

  it('refuses events that arrive out of order', async () => {
    const { db } = memory();
    const store = new SqliteBoardStore(db);
    const { events } = await scriptedRun(new SqliteBoardStore(memory().db));
    const [first, second] = events;
    if (first === undefined || second === undefined) throw new Error('no events');
    expect(await store.append(second)).toEqual({
      ok: false,
      error: { kind: 'out_of_order', runId: first.runId, expected: 0, actual: 1 },
    });
    expect((await store.append(first)).ok).toBe(true);
    expect(await store.append(first)).toEqual({
      ok: false,
      error: { kind: 'out_of_order', runId: first.runId, expected: 1, actual: 0 },
    });
    expect((await store.eventsFor(first.runId)).length).toBe(1);
  });

  it('reports a closed database as unavailable', async () => {
    const o = openDatabase(IN_MEMORY);
    const store = new SqliteBoardStore(o.db);
    const { events } = await scriptedRun(new SqliteBoardStore(memory().db));
    o.close();
    const first = events[0];
    if (first === undefined) throw new Error('no events');
    const result = await store.append(first);
    expect(!result.ok && result.error.kind).toBe('unavailable');
  });

  it('persists to a file, in WAL mode, and reopens with the schema already applied', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'swarm-host-'));
    tempDirs.push(dir);
    const url = `file:${join(dir, 'nested', 'team.db')}`;
    const first = openDatabase(url);
    expect(first.sqlite.pragma('journal_mode', { simple: true })).toBe('wal');
    const { controller } = await scriptedRun(new SqliteBoardStore(first.db));
    first.close();

    const again = openDatabase(url);
    opened.push(again);
    const replayed = await new SqliteBoardStore(again.db).eventsFor(controller.runId);
    expect(replayed.at(-1)?.type).toBe('run_terminated');
    expect(again.path.endsWith('team.db')).toBe(true);
  });
});
