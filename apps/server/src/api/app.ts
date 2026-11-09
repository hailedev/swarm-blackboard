import {
  buildBoardView,
  calendarMonth,
  resolveProfile,
  type BoardEvent,
  type Clock,
  type ControllerError,
  type Roster,
} from '@team/core';
import type { MonthlyBudgetSettings } from '@team/host';
import { Hono, type Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

import type { RunManager, RunManagerError } from '../run-manager';
import { InjectNoteRequestSchema, StartRunRequestSchema } from './schemas';

// The Hono API (docs/PLAN.md §6, Phase 3): runs, board, log, trace, budget, and the SSE
// event stream. Every body is validated with Zod; every error is one JSON envelope.

export interface AppDeps {
  manager: RunManager;
  roster: Roster;
  monthlyBudget: MonthlyBudgetSettings;
  clock: Clock;
}

/** How long the event stream stays silent before it says it is still there. */
export const SSE_PING_MS = 15_000;

const fail = (
  c: Context,
  status: ContentfulStatusCode,
  code: string,
  message: string,
  details?: unknown,
) => c.json({ error: { code, message, ...(details === undefined ? {} : { details }) } }, status);

const controllerFailure = (c: Context, error: ControllerError) => {
  switch (error.kind) {
    case 'monthly_budget':
      return fail(
        c,
        409,
        'monthly_budget',
        `$${error.spentUsd.toFixed(4)} of $${error.limitUsd.toFixed(4)} already spent this month; a per-run cap of $${error.fitsCapUsd.toFixed(4)} or less would fit, $${error.requestedCapUsd.toFixed(4)} was asked for`,
        error,
      );
    case 'invalid_config':
    case 'invalid_problem':
    case 'invalid_note':
      return fail(c, 400, error.kind, error.issues.join('; '), error.issues);
    case 'not_paused':
    case 'paused':
    case 'terminated':
    case 'already_started':
    case 'not_started':
      return fail(c, 409, error.kind, `the run is ${error.kind.replace('_', ' ')}`, error);
    case 'ledger':
      return fail(c, 503, 'ledger', error.message);
    case 'store':
      return fail(c, 500, 'store', error.error.kind);
  }
};

const managerFailure = (c: Context, error: RunManagerError) => {
  switch (error.kind) {
    case 'not_found':
      return fail(c, 404, 'not_found', 'no such run');
    case 'not_live':
      return fail(c, 409, 'not_live', `the run is ${error.status}`, { status: error.status });
    case 'roster':
      return fail(c, 400, 'roster', error.message);
    case 'models':
      return fail(c, 503, 'models_unavailable', error.message);
    case 'rehydrate':
      return fail(c, 500, 'rehydrate', `cannot rebuild the run from its log: ${error.error.kind}`);
    case 'controller':
      return controllerFailure(c, error.error);
  }
};

const parseBody = async <T>(
  c: Context,
  schema: {
    safeParse: (
      value: unknown,
    ) =>
      | { success: true; data: T }
      | { success: false; error: { issues: { path: PropertyKey[]; message: string }[] } };
  },
): Promise<{ ok: true; data: T } | { ok: false; response: Response }> => {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return { ok: false, response: fail(c, 400, 'invalid_json', 'the body is not JSON') };
  }
  const parsed = schema.safeParse(raw);
  if (parsed.success) return { ok: true, data: parsed.data };
  const issues = parsed.error.issues.map((i) => `${i.path.map(String).join('.')}: ${i.message}`);
  return { ok: false, response: fail(c, 400, 'invalid_request', issues.join('; '), issues) };
};

export const createApp = ({ manager, roster, monthlyBudget, clock }: AppDeps): Hono => {
  const app = new Hono();

  app.get('/health', (c) => c.json({ ok: true, at: new Date(clock.nowMs()).toISOString() }));

  app.get('/profiles', (c) => {
    const profiles = Object.keys(roster.profiles).flatMap((name) => {
      const resolved = resolveProfile(roster, name);
      return resolved.ok ? [resolved.value] : [];
    });
    return c.json({ defaultProfile: roster.defaultProfile, profiles });
  });

  app.get('/budget', async (c) => {
    const period = calendarMonth(clock.nowMs(), monthlyBudget.timeZone);
    if (!period.ok)
      return fail(c, 500, 'time_zone', `unknown time zone "${monthlyBudget.timeZone}"`);
    const spentUsd = await manager.ledger.spentUsd(period.value);
    return c.json({
      period: period.value,
      spentUsd,
      limitUsd: monthlyBudget.limitUsd,
      warnAtFraction: monthlyBudget.warnAtFraction,
      timeZone: monthlyBudget.timeZone,
    });
  });

  app.get('/runs', (c) => c.json({ runs: manager.list() }));

  app.post('/runs', async (c) => {
    const body = await parseBody(c, StartRunRequestSchema);
    if (!body.ok) return body.response;
    const started = await manager.start(body.data);
    return started.ok ? c.json(started.value, 201) : managerFailure(c, started.error);
  });

  app.get('/runs/:id', (c) => {
    const record = manager.get(c.req.param('id'));
    return record === undefined ? fail(c, 404, 'not_found', 'no such run') : c.json(record);
  });

  app.post('/runs/:id/pause', async (c) => {
    const result = await manager.pause(c.req.param('id'));
    return result.ok ? c.json(result.value) : managerFailure(c, result.error);
  });

  app.post('/runs/:id/resume', async (c) => {
    const result = await manager.resume(c.req.param('id'));
    return result.ok ? c.json(result.value) : managerFailure(c, result.error);
  });

  app.post('/runs/:id/stop', async (c) => {
    const result = await manager.stop(c.req.param('id'));
    return result.ok ? c.json(result.value) : managerFailure(c, result.error);
  });

  app.post('/runs/:id/notes', async (c) => {
    const body = await parseBody(c, InjectNoteRequestSchema);
    if (!body.ok) return body.response;
    const result = await manager.inject(c.req.param('id'), body.data);
    return result.ok ? c.json(result.value, 201) : managerFailure(c, result.error);
  });

  app.get('/runs/:id/board', async (c) => {
    const runId = c.req.param('id');
    const events = await manager.store.eventsFor(runId);
    if (events.length === 0) return fail(c, 404, 'not_found', 'no such run');
    const view = buildBoardView(runId, events);
    return c.json({
      runId,
      round: view.round,
      lastEntryRound: view.lastEntryRound,
      entries: view.entries.map((entry) => ({
        ...entry,
        handle: view.handleOf(entry.id),
        live: view.isLive(entry.id),
      })),
    });
  });

  app.get('/runs/:id/log', async (c) => {
    const runId = c.req.param('id');
    const events = await manager.store.eventsFor(runId);
    if (events.length === 0) return fail(c, 404, 'not_found', 'no such run');
    return c.json({ runId, events });
  });

  app.get('/runs/:id/trace', (c) => {
    const runId = c.req.param('id');
    if (manager.get(runId) === undefined) return fail(c, 404, 'not_found', 'no such run');
    return c.json({ runId, calls: manager.calls.forRun(runId) });
  });

  app.get('/runs/:id/trace/:callId', (c) => {
    const call = manager.calls.byId(c.req.param('callId'));
    if (call === undefined || call.runId !== c.req.param('id')) {
      return fail(c, 404, 'not_found', 'no such model call');
    }
    return c.json(call);
  });

  // The event stream: everything after `from` (or Last-Event-ID) from the log, then live
  // events as they are stored, a ping while quiet, and the end of the stream after
  // run_terminated. A paused run keeps its stream open.
  app.get('/runs/:id/events', (c) => {
    const runId = c.req.param('id');
    const fromParam = c.req.query('from') ?? c.req.header('Last-Event-ID');
    const from = fromParam === undefined ? -1 : Number(fromParam);
    if (!Number.isInteger(from) || from < -1) {
      return fail(c, 400, 'invalid_request', '`from` must be an event sequence number');
    }
    return streamSSE(c, async (stream) => {
      const buffer: BoardEvent[] = [];
      let wake: (() => void) | null = null;
      let open = true;
      // Read through a function: callbacks flip `open`, which TypeScript would otherwise narrow away.
      const isOpen = (): boolean => open;
      const notify = (): void => {
        wake?.();
        wake = null;
      };
      // Subscribe before reading the backlog so nothing stored in between is missed;
      // anything seen twice is dropped by sequence number.
      const unsubscribe = manager.subscribe(runId, (event) => {
        buffer.push(event);
        notify();
      });
      stream.onAbort(() => {
        open = false;
        notify();
      });
      let sent = from;
      const send = async (event: BoardEvent): Promise<void> => {
        if (event.seq <= sent) return;
        sent = event.seq;
        await stream.writeSSE({
          id: String(event.seq),
          event: event.type,
          data: JSON.stringify(event),
        });
        if (event.type === 'run_terminated') open = false;
      };
      try {
        for (const event of await manager.store.eventsFor(runId)) {
          if (!isOpen()) break;
          await send(event);
        }
        while (isOpen()) {
          const next = buffer.shift();
          if (next !== undefined) {
            await send(next);
            continue;
          }
          const arrived = await new Promise<boolean>((resolve) => {
            const timer = setTimeout(() => {
              wake = null;
              resolve(false);
            }, SSE_PING_MS);
            wake = () => {
              clearTimeout(timer);
              resolve(true);
            };
          });
          if (!arrived && isOpen()) await stream.writeSSE({ event: 'ping', data: '' });
        }
      } finally {
        unsubscribe();
      }
    });
  });

  return app;
};
