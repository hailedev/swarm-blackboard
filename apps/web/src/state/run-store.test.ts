import { describe, expect, it } from 'vitest';

import { recordedEvents, recordedRunId } from '../testing/recorded-run';
import { createRunStore } from './run-store';

const events = recordedEvents();
const runId = recordedRunId();
const at = (seq: number) => {
  const event = events[seq];
  if (event === undefined) throw new Error(`no event ${String(seq)}`);
  return event;
};

describe('the run store', () => {
  it('takes events in order, ignores repeats, and starts afresh on another run', () => {
    const store = createRunStore();
    store.getState().open(runId);
    store.getState().append(runId, at(0));
    store.getState().append(runId, at(1));
    // A reconnect replays what is already held.
    store.getState().append(runId, at(0));
    store.getState().append(runId, at(1));
    store.getState().append(runId, at(2));
    expect(store.getState().events.map((e) => e.seq)).toEqual([0, 1, 2]);

    store.getState().setCursor(1);
    store.getState().selectEntry('entry');
    store.getState().open('another-run');
    expect(store.getState()).toMatchObject({
      runId: 'another-run',
      events: [],
      cursor: null,
      selectedEntryId: null,
      stream: { kind: 'idle' },
    });
    // The old run's stream may still be delivering: nothing of it lands here.
    store.getState().append(runId, at(0));
    store.getState().setStream(runId, { kind: 'open' });
    expect(store.getState().events).toEqual([]);
    expect(store.getState().stream).toEqual({ kind: 'idle' });
  });

  it('refuses a gap, says so, and does not let a later "open" hide it', () => {
    const store = createRunStore();
    store.getState().open(runId);
    store.getState().setStream(runId, { kind: 'open' });
    store.getState().append(runId, at(0));
    store.getState().append(runId, at(5));
    expect(store.getState().events.map((e) => e.seq)).toEqual([0]);
    const { stream } = store.getState();
    expect(stream.kind === 'failed' && stream.message).toContain('skipped from event 1 to 5');
    store.getState().setStream(runId, { kind: 'open' });
    expect(store.getState().stream.kind).toBe('failed');
  });

  it('holds the whole recorded run', () => {
    const store = createRunStore();
    store.getState().open(runId);
    for (const event of events) store.getState().append(runId, event);
    store.getState().setStream(runId, { kind: 'ended' });
    expect(store.getState().events.length).toBe(134);
    expect(store.getState().stream).toEqual({ kind: 'ended' });
  });
});
