import { fileURLToPath } from 'node:url';

import {
  buildBoardView,
  createController,
  createDefaultAgents,
  InMemoryBoardStore,
  isoFromMs,
  nullLogger,
  resolveProfile,
  ok,
  type AgentRole,
  type BoardEvent,
  type Model,
  type ModelCallTrace,
  type ModelRequest,
} from '@team/core';
import {
  createScriptedModels,
  ManualClock,
  SequentialIdGenerator,
  testRolePrompts,
} from '@team/core/testing';
import {
  DEFAULT_MONTHLY_BUDGET,
  loadRosterFile,
  openDatabase,
  SqliteBoardStore,
  type OpenedDatabase,
  type RunRecord,
} from '@team/host';
import { traceModel } from '@team/providers';
import type { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';

import { RunManager, type RunModelsSource } from '../run-manager';
import { createApp } from './app';
import {
  ApiErrorSchema,
  BudgetResponseSchema,
  ModelCallDetailSchema,
  ProfilesResponseSchema,
  RunListResponseSchema,
  RunRecordSchema,
  TraceResponseSchema,
} from './schemas';

const ROSTER = fileURLToPath(new URL('../../../../agents.yaml', import.meta.url));
const monthlyBudget = { ...DEFAULT_MONTHLY_BUDGET, timeZone: 'UTC' };

const opened: OpenedDatabase[] = [];
afterEach(() => {
  for (const o of opened.splice(0)) o.close();
});

// Holds the solver's first model call until the test says so, so a run can be caught
// mid-round deterministically. `reached` resolves when the held call has begun.
const gate = () => {
  let release: () => void = () => undefined;
  let arrive: () => void = () => undefined;
  const open = new Promise<void>((resolve) => {
    release = resolve;
  });
  const reached = new Promise<void>((resolve) => {
    arrive = resolve;
  });
  let held = false;
  const wrap = (model: Model): Model => ({
    id: model.id,
    billing: model.billing,
    pricing: model.pricing,
    charsPerToken: model.charsPerToken,
    generateObject: async <T>(request: ModelRequest<T>) => {
      if (!held) {
        held = true;
        arrive();
        await open;
      }
      return model.generateObject(request);
    },
  });
  return {
    wrap,
    release: () => {
      release();
    },
    reached,
  };
};

const scriptedSource =
  (wrapSolver?: (model: Model) => Model): RunModelsSource =>
  ({ currentView, sink }) => {
    const raw = createScriptedModels(currentView);
    const models = Object.fromEntries(
      Object.entries(raw).map(([role, model]) => [role, traceModel(model, sink)]),
    ) as Record<AgentRole, Model>;
    return Promise.resolve(
      ok({
        roles: {
          ...models,
          solver: wrapSolver === undefined ? models.solver : wrapSolver(models.solver),
        },
        fallback: undefined,
      }),
    );
  };

const setup = async (source: RunModelsSource = scriptedSource(), idsFrom = 0) => {
  const o = openDatabase(':memory:');
  opened.push(o);
  const roster = await loadRosterFile(ROSTER);
  if (!roster.ok) throw new Error(roster.error);
  const clock = new ManualClock();
  const manager = new RunManager({
    db: o.db,
    roster: roster.value,
    prompts: testRolePrompts(),
    clock,
    ids: new SequentialIdGenerator(idsFrom),
    logger: nullLogger,
    monthlyBudget,
    models: source,
  });
  const app = createApp({ manager, roster: roster.value, monthlyBudget, clock });
  return { app, manager, db: o.db, clock, roster: roster.value };
};

const post = (app: Hono, path: string, body?: unknown): Promise<Response> | Response =>
  app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const body = async <T>(res: Response): Promise<T> => (await res.json()) as T;
type ErrorBody = { error: { code: string; message: string; details?: unknown } };

const startRun = async (app: Hono, extra: Record<string, unknown> = {}): Promise<RunRecord> => {
  const res = await post(app, '/runs', {
    problem: { content: 'Should we adopt a monorepo?' },
    ...extra,
  });
  expect(res.status).toBe(201);
  return body<RunRecord>(res);
};

interface SseEvent {
  id: string | undefined;
  event: string | undefined;
  data: string;
}

const parseSse = (text: string): SseEvent[] =>
  text
    .split('\n\n')
    .filter((block) => block.trim() !== '')
    .map((block) => {
      const fields = new Map(
        block.split('\n').map((line) => {
          const i = line.indexOf(':');
          return [line.slice(0, i), line.slice(i + 1).trim()] as const;
        }),
      );
      return { id: fields.get('id'), event: fields.get('event'), data: fields.get('data') ?? '' };
    });

// Reads a live stream block by block until `until` is satisfied or the stream closes.
const readStream = async (
  res: Response,
  until: (seen: readonly SseEvent[]) => boolean,
): Promise<{
  seen: SseEvent[];
  closed: boolean;
  reader: ReadableStreamDefaultReader<Uint8Array>;
}> => {
  if (res.body === null) throw new Error('no body');
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  const seen: SseEvent[] = [];
  let pending = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return { seen, closed: true, reader };
    pending += decoder.decode(value, { stream: true });
    const blocks = pending.split('\n\n');
    pending = blocks.pop() ?? '';
    seen.push(...parseSse(blocks.join('\n\n')));
    if (until(seen)) return { seen, closed: false, reader };
  }
};

describe('GET /health, /profiles, /budget', () => {
  it('answers with the roster profiles and the month-to-date budget', async () => {
    const { app } = await setup();
    const health = await app.request('/health');
    expect(health.status).toBe(200);
    expect(await body<{ ok: boolean }>(health)).toMatchObject({ ok: true });

    const profiles = await body<{
      defaultProfile: string;
      profiles: { name: string; paid: boolean }[];
    }>(await app.request('/profiles'));
    expect(profiles.defaultProfile).toBe('dev');
    expect(profiles.profiles.map((p) => [p.name, p.paid])).toEqual([
      ['dev', false],
      ['cheap', true],
      ['quality', true],
    ]);

    const budget = await body<{ spentUsd: number; limitUsd: number; period: { start: string } }>(
      await app.request('/budget'),
    );
    expect(budget).toMatchObject({ spentUsd: 0, limitUsd: 5 });
    expect(budget.period.start).toBe('2026-01-01T00:00:00.000Z');
  });
});

describe('runs', () => {
  it('starts a run and exposes it, its board with handles, its log and its trace', async () => {
    const { app, manager } = await setup();
    const started = await startRun(app);
    expect(started).toMatchObject({
      status: 'running',
      problem: 'Should we adopt a monorepo?',
      profileName: 'dev',
    });
    await manager.settled(started.id);

    const run = await body<RunRecord>(await app.request(`/runs/${started.id}`));
    expect(run).toMatchObject({ status: 'completed', reason: 'completed', totals: { rounds: 4 } });
    expect(
      (await body<{ runs: RunRecord[] }>(await app.request('/runs'))).runs.map((r) => r.id),
    ).toEqual([started.id]);

    const board = await body<{
      round: number;
      entries: { id: string; type: string; handle: string; live: boolean }[];
    }>(await app.request(`/runs/${started.id}/board`));
    expect(board.round).toBe(4);
    expect(board.entries[0]).toMatchObject({ type: 'problem', handle: 'P1', live: true });
    expect(board.entries.filter((e) => e.type === 'synthesis').map((e) => e.handle)).toEqual([
      'A1',
    ]);
    expect(
      board.entries.filter((e) => e.type === 'hypothesis').map((e) => [e.handle, e.live]),
    ).toEqual([
      ['H1', false],
      ['H2', true],
    ]);

    const log = await body<{ events: BoardEvent[] }>(await app.request(`/runs/${started.id}/log`));
    expect(log.events[0]?.type).toBe('run_started');
    expect(log.events.at(-1)?.type).toBe('run_terminated');
    expect(log.events.map((e) => e.seq)).toEqual(log.events.map((_, i) => i));
    // The board is exactly the fold of the log.
    const folded = buildBoardView(started.id, log.events);
    expect(board.entries.map((e) => [e.id, e.handle])).toEqual(
      folded.entries.map((e) => [e.id, folded.handleOf(e.id)]),
    );

    const trace = await body<{ calls: Record<string, unknown>[] }>(
      await app.request(`/runs/${started.id}/trace`),
    );
    expect(trace.calls.length).toBe(7);
    expect(trace.calls.every((c) => c['billing'] === 'fake' && !('prompt' in c))).toBe(true);
    const callId = trace.calls[0]?.['id'];
    const call = await body<{ prompt: string; system: string }>(
      await app.request(`/runs/${started.id}/trace/${String(callId)}`),
    );
    expect(call.prompt).toContain('# Problem (P1)');

    expect((await app.request('/runs/nope')).status).toBe(404);
    expect((await app.request('/runs/nope/board')).status).toBe(404);
    expect((await app.request('/runs/nope/log')).status).toBe(404);
    expect((await app.request('/runs/nope/trace')).status).toBe(404);
    expect((await app.request(`/runs/${started.id}/trace/nope`)).status).toBe(404);
  });

  it('validates requests and names unknown profiles', async () => {
    const { app } = await setup();
    const empty = await post(app, '/runs', {});
    expect(empty.status).toBe(400);
    expect((await body<ErrorBody>(empty)).error.code).toBe('invalid_request');
    const notJson = await app.request('/runs', { method: 'POST', body: 'nope' });
    expect((await body<ErrorBody>(notJson)).error.code).toBe('invalid_json');
    const badConfig = await post(app, '/runs', {
      problem: { content: 'P' },
      config: { maxRounds: 0 },
    });
    expect(badConfig.status).toBe(400);
    const unknown = await post(app, '/runs', { problem: { content: 'P' }, profile: 'prod' });
    expect(unknown.status).toBe(400);
    expect((await body<ErrorBody>(unknown)).error.message).toContain('valid profiles are');
    const badNote = await post(app, '/runs/nope/notes', { content: '' });
    expect(badNote.status).toBe(400);
    expect((await post(app, '/runs/nope/notes', { content: 'x' })).status).toBe(404);
    expect((await post(app, '/runs/nope/pause')).status).toBe(404);
  });

  it('pauses after the round in flight, takes a note, resumes and finishes', async () => {
    const held = gate();
    const { app, manager } = await setup(scriptedSource(held.wrap));
    const started = await startRun(app);
    await held.reached;
    const pausing = post(app, `/runs/${started.id}/pause`);
    held.release();
    const paused = await body<RunRecord>(await pausing);
    expect(paused).toMatchObject({
      status: 'paused',
      reason: 'user_paused',
      totals: { rounds: 2 },
    });

    const noted = await post(app, `/runs/${started.id}/notes`, {
      content: 'Prefer SQLite',
      priority: 'high',
    });
    expect(noted.status).toBe(201);
    expect(await body<{ type: string; round: number }>(noted)).toMatchObject({
      type: 'human_note',
      round: 2,
    });
    const board = await body<{ entries: { handle: string; type: string }[] }>(
      await app.request(`/runs/${started.id}/board`),
    );
    expect(board.entries.find((e) => e.type === 'human_note')?.handle).toBe('N1');

    const resumed = await body<RunRecord>(await post(app, `/runs/${started.id}/resume`));
    expect(resumed.status).toBe('running');
    await manager.settled(started.id);
    const done = await body<RunRecord>(await app.request(`/runs/${started.id}`));
    expect(done).toMatchObject({ status: 'completed', reason: 'completed', totals: { rounds: 4 } });

    for (const action of ['pause', 'resume', 'stop']) {
      const res = await post(app, `/runs/${started.id}/${action}`);
      expect(res.status).toBe(409);
    }
    expect((await post(app, `/runs/${started.id}/notes`, { content: 'late' })).status).toBe(409);
  });

  it('stops a live run after its round and a paused run at once', async () => {
    const held = gate();
    const { app } = await setup(scriptedSource(held.wrap));
    const live = await startRun(app);
    await held.reached;
    const stopping = post(app, `/runs/${live.id}/stop`);
    held.release();
    expect(await body<RunRecord>(await stopping)).toMatchObject({
      status: 'stopped',
      reason: 'user_stopped',
      totals: { rounds: 2 },
    });

    const again = gate();
    const second = await setup(scriptedSource(again.wrap));
    const run = await startRun(second.app);
    await again.reached;
    const pausing = post(second.app, `/runs/${run.id}/pause`);
    again.release();
    expect((await body<RunRecord>(await pausing)).status).toBe('paused');
    expect(await body<RunRecord>(await post(second.app, `/runs/${run.id}/stop`))).toMatchObject({
      status: 'stopped',
      reason: 'user_stopped',
    });
  });

  it('refuses a paid profile the month cannot absorb', async () => {
    const { app, manager, clock } = await setup();
    const trace: ModelCallTrace = {
      at: isoFromMs(clock.nowMs()),
      modelId: 'claude-sonnet-5-5',
      billing: 'api',
      tags: { role: 'critic', runId: 'earlier', round: 1 },
      request: { system: 's', prompt: 'p', maxOutputTokens: 512 },
      outcome: 'ok',
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 4.9,
      },
      estimate: { chars: 2, charsPerToken: 2, tokens: 1 },
      actualInputTokens: 1,
      warnings: [],
      latencyMs: 1,
      response: {},
      error: null,
    };
    manager.calls.record(trace);
    const refused = await post(app, '/runs', { problem: { content: 'P' }, profile: 'quality' });
    expect(refused.status).toBe(409);
    expect((await body<ErrorBody>(refused)).error.code).toBe('monthly_budget');
    expect((await body<{ spentUsd: number }>(await app.request('/budget'))).spentUsd).toBeCloseTo(
      4.9,
      10,
    );
    // The free profile is never refused.
    expect((await post(app, '/runs', { problem: { content: 'P' } })).status).toBe(201);
  });
});

describe('the contract the web app parses', () => {
  it('every response the UI reads satisfies its schema, with no field the schema does not name', async () => {
    const { app, manager } = await setup();
    const started = await startRun(app);
    // A running record has no reason; every other status carries one.
    expect(RunRecordSchema.strict().parse(started)).toMatchObject({
      status: 'running',
      reason: null,
    });
    await manager.settled(started.id);

    const json = async (path: string): Promise<unknown> => (await app.request(path)).json();
    const record = RunRecordSchema.strict().parse(await json(`/runs/${started.id}`));
    expect([record.status, record.reason]).toEqual(['completed', 'completed']);
    expect(RunListResponseSchema.strict().parse(await json('/runs')).runs).toEqual([record]);
    expect(ProfilesResponseSchema.strict().parse(await json('/profiles')).defaultProfile).toBe(
      'dev',
    );
    expect(BudgetResponseSchema.strict().parse(await json('/budget')).limitUsd).toBe(5);

    const trace = TraceResponseSchema.strict().parse(await json(`/runs/${started.id}/trace`));
    expect(trace.calls.length).toBe(7);
    const first = trace.calls[0];
    if (first === undefined) throw new Error('no calls');
    const detail = ModelCallDetailSchema.strict().parse(
      await json(`/runs/${started.id}/trace/${first.id}`),
    );
    expect(detail).toMatchObject({ ...first, system: expect.any(String) as unknown });

    expect(ApiErrorSchema.parse(await json('/runs/nope')).error.code).toBe('not_found');
  });
});

describe('POST /runs/:id/synthesize', () => {
  it('records the request and runs the Synthesizer in the next round to start', async () => {
    const held = gate();
    const { app, manager } = await setup(scriptedSource(held.wrap));
    const started = await startRun(app);
    // Round 2 is in flight (the Solver's call is held): the request waits for round 3.
    await held.reached;
    const asked = await post(app, `/runs/${started.id}/synthesize`);
    expect(asked.status).toBe(200);
    expect(RunRecordSchema.parse(await asked.json()).status).toBe('running');
    held.release();
    await manager.settled(started.id);

    const log = await body<{ events: BoardEvent[] }>(await app.request(`/runs/${started.id}/log`));
    const requested = log.events.find((e) => e.type === 'synthesis_requested');
    expect(requested).toMatchObject({ round: 1 });
    const selections = log.events.flatMap((e) => (e.type === 'agents_selected' ? [e] : []));
    expect(selections.map((e) => e.selected)).toEqual([
      ['planner'],
      ['solver', 'researcher'],
      ['synthesizer', 'critic'],
    ]);
    expect(selections[2]?.eligible.find((e) => e.agentId === 'synthesizer')?.reason).toBe(
      'forced by the user',
    );
    // The scripted Synthesizer is confident and nothing blocks, so the run ends a round
    // earlier than it would have: the usual termination rules, not the request, decide.
    expect(await body<RunRecord>(await app.request(`/runs/${started.id}`))).toMatchObject({
      status: 'completed',
      reason: 'completed',
      totals: { rounds: 3 },
    });
    expect(log.events.map((e) => e.seq)).toEqual(log.events.map((_, i) => i));

    const late = await post(app, `/runs/${started.id}/synthesize`);
    expect(late.status).toBe(409);
    expect((await post(app, '/runs/nope/synthesize')).status).toBe(404);
  });

  it('takes a request for a paused run and serves it after the resume', async () => {
    const held = gate();
    const { app, manager } = await setup(scriptedSource(held.wrap));
    const started = await startRun(app);
    await held.reached;
    const pausing = post(app, `/runs/${started.id}/pause`);
    held.release();
    expect((await body<RunRecord>(await pausing)).status).toBe('paused');

    const asked = await post(app, `/runs/${started.id}/synthesize`);
    expect(asked.status).toBe(200);
    expect((await body<RunRecord>(asked)).status).toBe('paused');
    await post(app, `/runs/${started.id}/resume`);
    await manager.settled(started.id);
    const log = await body<{ events: BoardEvent[] }>(await app.request(`/runs/${started.id}/log`));
    const selections = log.events.flatMap((e) =>
      e.type === 'agents_selected' ? [e.selected] : [],
    );
    expect(selections[2]?.[0]).toBe('synthesizer');
  });
});

describe('GET /runs/:id/events', () => {
  it('streams the whole log of a finished run and closes, and resumes from Last-Event-ID', async () => {
    const { app, manager } = await setup();
    const started = await startRun(app);
    await manager.settled(started.id);

    const res = await app.request(`/runs/${started.id}/events`);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const events = parseSse(await res.text());
    expect(events[0]).toMatchObject({ id: '0', event: 'run_started' });
    expect(events.at(-1)?.event).toBe('run_terminated');
    expect(events.map((e) => Number(e.id))).toEqual(events.map((_, i) => i));
    expect((JSON.parse(events[1]?.data ?? '{}') as BoardEvent).type).toBe('entry_committed');

    const later = parseSse(
      await (
        await app.request(`/runs/${started.id}/events`, { headers: { 'Last-Event-ID': '5' } })
      ).text(),
    );
    expect(later[0]?.id).toBe('6');
    const fromQuery = parseSse(
      await (await app.request(`/runs/${started.id}/events?from=5`)).text(),
    );
    expect(fromQuery.map((e) => e.id)).toEqual(later.map((e) => e.id));
    expect((await app.request(`/runs/${started.id}/events?from=x`)).status).toBe(400);
  });

  it('answers 404 for an unknown run instead of opening an empty stream', async () => {
    const { app } = await setup();
    const res = await app.request('/runs/nope/events');
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(ApiErrorSchema.parse(await res.json()).error.code).toBe('not_found');
  });

  it('delivers live events as the run goes on, without gaps or repeats', async () => {
    const held = gate();
    const { app } = await setup(scriptedSource(held.wrap));
    const started = await startRun(app);
    await held.reached;
    // Round 2 is in flight: the backlog ends at its agents_selected event.
    const res = await app.request(`/runs/${started.id}/events`);
    const first = await readStream(res, (seen) =>
      seen.some(
        (e) =>
          e.event === 'agents_selected' &&
          (JSON.parse(e.data) as BoardEvent).type === 'agents_selected' &&
          (JSON.parse(e.data) as { round: number }).round === 2,
      ),
    );
    expect(first.closed).toBe(false);
    held.release();
    const decoder = new TextDecoder();
    let rest = '';
    for (;;) {
      const { value, done } = await first.reader.read();
      if (done) break;
      rest += decoder.decode(value, { stream: true });
    }
    const all = [...first.seen, ...parseSse(rest)];
    expect(all.map((e) => Number(e.id))).toEqual(all.map((_, i) => i));
    expect(all.at(-1)?.event).toBe('run_terminated');
    expect(all.filter((e) => e.event === 'round_completed').length).toBe(4);
  });
});

describe('recovery', () => {
  it('pauses a run a dead process left running as interrupted, then resumes it from the log', async () => {
    const { app, manager, db, roster } = await setup(scriptedSource(), 1_000);
    const profile = resolveProfile(roster, 'dev');
    if (!profile.ok) throw new Error('no dev profile');
    // A run driven by some other process over the same database, cut off after round 2.
    const store = new SqliteBoardStore(db);
    const ref: { controller: ReturnType<typeof createController> | undefined } = {
      controller: undefined,
    };
    const models = createScriptedModels(() => {
      if (ref.controller === undefined) throw new Error('not ready');
      return ref.controller.currentView();
    });
    const controller = createController({
      store,
      clock: new ManualClock(),
      ids: new SequentialIdGenerator(),
      logger: nullLogger,
      agents: createDefaultAgents(models, testRolePrompts()),
      profile: profile.value,
    });
    ref.controller = controller;
    await controller.start({ content: 'P' });
    await controller.runRound();
    await controller.runRound();
    expect(manager.get(controller.runId)?.status).toBe('running');

    expect(await manager.recover()).toBe(1);
    expect(await manager.recover()).toBe(0);
    const paused = await body<RunRecord>(await app.request(`/runs/${controller.runId}`));
    expect(paused).toMatchObject({
      status: 'paused',
      reason: 'interrupted',
      totals: { rounds: 2 },
    });

    const resumed = await post(app, `/runs/${controller.runId}/resume`);
    expect(resumed.status).toBe(200);
    await manager.settled(controller.runId);
    const done = await body<RunRecord>(await app.request(`/runs/${controller.runId}`));
    expect(done).toMatchObject({ status: 'completed', reason: 'completed', totals: { rounds: 4 } });
    const log = await body<{ events: BoardEvent[] }>(
      await app.request(`/runs/${controller.runId}/log`),
    );
    expect(log.events.map((e) => e.type).filter((t) => t.startsWith('run_'))).toEqual([
      'run_started',
      'run_paused',
      'run_resumed',
      'run_terminated',
    ]);
    expect(log.events.map((e) => e.seq)).toEqual(log.events.map((_, i) => i));
  });

  it('abandons a round the dead process left in flight, so the resumed run starts each round once', async () => {
    const { app, manager, db, roster } = await setup(scriptedSource(), 1_000);
    const profile = resolveProfile(roster, 'dev');
    if (!profile.ok) throw new Error('no dev profile');
    // The log of a whole scripted run, written by another process into its own memory…
    const memory = new InMemoryBoardStore();
    const ref: { controller: ReturnType<typeof createController> | undefined } = {
      controller: undefined,
    };
    const models = createScriptedModels(() => {
      if (ref.controller === undefined) throw new Error('not ready');
      return ref.controller.currentView();
    });
    const controller = createController({
      store: memory,
      clock: new ManualClock(),
      ids: new SequentialIdGenerator(),
      logger: nullLogger,
      agents: createDefaultAgents(models, testRolePrompts()),
      profile: profile.value,
    });
    ref.controller = controller;
    await controller.start({ content: 'P' });
    await controller.run();
    const whole = await memory.eventsFor(controller.runId);
    // …of which only the part up to the selection of round 3 reached the shared database.
    const cutAt = whole.findIndex((e) => e.type === 'agents_selected' && e.round === 3);
    expect(cutAt).toBeGreaterThan(-1);
    const store = new SqliteBoardStore(db);
    for (const event of whole.slice(0, cutAt + 1)) {
      expect((await store.append(event)).ok).toBe(true);
    }
    expect(manager.get(controller.runId)?.status).toBe('running');

    expect(await manager.recover()).toBe(1);
    const paused = await body<RunRecord>(await app.request(`/runs/${controller.runId}`));
    expect(paused).toMatchObject({
      status: 'paused',
      reason: 'interrupted',
      totals: { rounds: 3 },
    });
    const log = await body<{ events: BoardEvent[] }>(
      await app.request(`/runs/${controller.runId}/log`),
    );
    expect(log.events.slice(cutAt - 1).map((e) => [e.type, 'round' in e ? e.round : null])).toEqual(
      [
        ['round_started', 3],
        ['agents_selected', 3],
        ['round_abandoned', 3],
        ['run_paused', 3],
      ],
    );
    expect(log.events.find((e) => e.type === 'round_abandoned')).toMatchObject({
      newEntries: 0,
      usage: { costUsd: 0 },
    });

    const resumed = await post(app, `/runs/${controller.runId}/resume`);
    expect(resumed.status).toBe(200);
    await manager.settled(controller.runId);
    const done = await body<RunRecord>(await app.request(`/runs/${controller.runId}`));
    expect(done).toMatchObject({ status: 'completed', reason: 'completed' });
    const after = await body<{ events: BoardEvent[] }>(
      await app.request(`/runs/${controller.runId}/log`),
    );
    const starts = after.events.flatMap((e) => (e.type === 'round_started' ? [e.round] : []));
    expect(starts.slice(0, 4)).toEqual([1, 2, 3, 4]);
    expect(new Set(starts).size).toBe(starts.length);
    expect(after.events.map((e) => e.seq)).toEqual(after.events.map((_, i) => i));
  });
});
