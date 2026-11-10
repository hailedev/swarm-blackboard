import { BoardEventSchema, type BoardEvent, type BoardEventType } from '@team/core';

import { API_BASE } from './client';

// The run's event stream (GET /runs/:id/events): the whole log, then live events, closed
// by the server after `run_terminated`. A paused run keeps its stream open.
//
// The server names each SSE message after its event type, so there is one listener per
// type. No `from` is passed: a first connection gets the log from the start, and when the
// browser reconnects it sends Last-Event-ID itself and the server resumes after it.

/** Every event type, checked against core's union so a new one cannot be missed. */
const EVENT_TYPES = Object.keys({
  run_started: true,
  round_started: true,
  agents_selected: true,
  entry_committed: true,
  agent_failed: true,
  round_completed: true,
  round_abandoned: true,
  synthesis_requested: true,
  budget_warning: true,
  run_paused: true,
  run_resumed: true,
  run_terminated: true,
} satisfies Record<BoardEventType, true>);

export type StreamState =
  /** Connecting, or reconnecting after a drop. */
  | { kind: 'connecting' }
  | { kind: 'open' }
  /** The run ended and the stream with it: the log is complete. */
  | { kind: 'ended' }
  | { kind: 'failed'; message: string };

export interface StreamHandlers {
  onEvent: (event: BoardEvent) => void;
  onState: (state: StreamState) => void;
}

/** The slice of EventSource this module uses; tests stand in for it. */
export interface EventSourceLike {
  readonly readyState: number;
  onopen: (() => void) | null;
  onerror: (() => void) | null;
  addEventListener: (type: string, listener: (message: { data: string }) => void) => void;
  close: () => void;
}

export type EventSourceFactory = (url: string) => EventSourceLike;

const CLOSED = 2;

const browserEventSource: EventSourceFactory = (url) => {
  const source = new EventSource(url);
  const like: EventSourceLike = {
    get readyState() {
      return source.readyState;
    },
    onopen: null,
    onerror: null,
    addEventListener: (type, listener) => {
      source.addEventListener(type, (message: MessageEvent<unknown>) => {
        if (typeof message.data === 'string') listener({ data: message.data });
      });
    },
    close: () => {
      source.close();
    },
  };
  source.onopen = () => {
    like.onopen?.();
  };
  source.onerror = () => {
    like.onerror?.();
  };
  return like;
};

/** Opens the stream of `runId`; the returned function closes it. */
export const openEventStream = (
  runId: string,
  handlers: StreamHandlers,
  create: EventSourceFactory = browserEventSource,
): (() => void) => {
  const source = create(`${API_BASE}/runs/${encodeURIComponent(runId)}/events`);
  let done = false;
  const finish = (state: StreamState): void => {
    if (done) return;
    done = true;
    source.close();
    handlers.onState(state);
  };

  handlers.onState({ kind: 'connecting' });
  source.onopen = () => {
    if (!done) handlers.onState({ kind: 'open' });
  };
  source.onerror = () => {
    if (done) return;
    // The browser retries by itself unless it has given up (readyState CLOSED).
    if (source.readyState === CLOSED) {
      finish({ kind: 'failed', message: 'The event stream closed and could not be reopened.' });
    } else {
      handlers.onState({ kind: 'connecting' });
    }
  };

  const onMessage = (message: { data: string }): void => {
    if (done) return;
    let raw: unknown;
    try {
      raw = JSON.parse(message.data);
    } catch {
      finish({ kind: 'failed', message: 'The event stream sent something that is not JSON.' });
      return;
    }
    const parsed = BoardEventSchema.safeParse(raw);
    if (!parsed.success) {
      finish({
        kind: 'failed',
        message: 'The event stream sent an event this version of the web app does not know.',
      });
      return;
    }
    handlers.onEvent(parsed.data);
    if (parsed.data.type === 'run_terminated') finish({ kind: 'ended' });
  };
  for (const type of EVENT_TYPES) source.addEventListener(type, onMessage);

  return () => {
    if (done) return;
    done = true;
    source.close();
  };
};
