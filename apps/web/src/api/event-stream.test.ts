import type { BoardEvent } from '@team/core';
import { describe, expect, it } from 'vitest';

import { recordedEvents } from '../testing/recorded-run';
import { openEventStream, type EventSourceLike, type StreamState } from './event-stream';

// A stand-in for the browser's EventSource: the test delivers the messages.
class FakeEventSource implements EventSourceLike {
  readyState = 0;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  readonly listeners = new Map<string, (message: { data: string }) => void>();

  constructor(readonly url: string) {}

  addEventListener(type: string, listener: (message: { data: string }) => void): void {
    this.listeners.set(type, listener);
  }

  close(): void {
    this.closed = true;
    this.readyState = 2;
  }

  send(event: BoardEvent): void {
    this.listeners.get(event.type)?.({ data: JSON.stringify(event) });
  }
}

const open = (runId = 'run 1') => {
  const sources: FakeEventSource[] = [];
  const seen: BoardEvent[] = [];
  const states: StreamState[] = [];
  const close = openEventStream(
    runId,
    {
      onEvent: (event) => seen.push(event),
      onState: (state) => states.push(state),
    },
    (url) => {
      const source = new FakeEventSource(url);
      sources.push(source);
      return source;
    },
  );
  const source = sources[0];
  if (source === undefined) throw new Error('no event source was created');
  return { source, seen, states, close };
};

describe('openEventStream', () => {
  it('listens for every event type on the run’s stream and delivers them parsed', () => {
    const { source, seen, states } = open();
    expect(source.url).toBe('/api/runs/run%201/events');
    expect([...source.listeners.keys()].sort()).toEqual(
      [
        'agent_failed',
        'agents_selected',
        'budget_warning',
        'entry_committed',
        'round_abandoned',
        'round_completed',
        'round_started',
        'run_paused',
        'run_resumed',
        'run_started',
        'run_terminated',
        'synthesis_requested',
      ].sort(),
    );
    source.onopen?.();
    const events = recordedEvents();
    for (const event of events) source.send(event);
    expect(seen).toEqual(events);
    // The run ended: the stream is closed here, not left to reconnect for ever.
    expect(source.closed).toBe(true);
    expect(states).toEqual([{ kind: 'connecting' }, { kind: 'open' }, { kind: 'ended' }]);
  });

  it('reports a drop as reconnecting while the browser retries, and as failed once it gives up', () => {
    const { source, states } = open();
    source.onopen?.();
    source.readyState = 0;
    source.onerror?.();
    expect(states.at(-1)).toEqual({ kind: 'connecting' });
    source.onopen?.();
    source.readyState = 2;
    source.onerror?.();
    expect(states.at(-1)?.kind).toBe('failed');
    expect(source.closed).toBe(true);
  });

  it('stops on anything that is not an event it knows, instead of showing a board with a hole', () => {
    const unknown = open();
    unknown.source.listeners.get('round_started')?.({ data: '{"type":"round_exploded"}' });
    expect(unknown.states.at(-1)?.kind).toBe('failed');
    expect(unknown.seen).toEqual([]);

    const garbled = open();
    garbled.source.listeners.get('round_started')?.({ data: 'not json' });
    expect(garbled.states.at(-1)).toMatchObject({ kind: 'failed' });
    // Nothing more is delivered once the stream has failed.
    const first = recordedEvents()[0];
    if (first !== undefined) garbled.source.send(first);
    expect(garbled.seen).toEqual([]);
  });

  it('goes quiet when closed by the page', () => {
    const { source, seen, states, close } = open();
    close();
    expect(source.closed).toBe(true);
    const first = recordedEvents()[0];
    if (first !== undefined) source.send(first);
    source.onopen?.();
    source.onerror?.();
    expect(seen).toEqual([]);
    expect(states).toEqual([{ kind: 'connecting' }]);
  });
});
