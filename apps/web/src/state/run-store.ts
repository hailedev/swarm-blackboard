import type { BoardEvent } from '@team/core';
import { create } from 'zustand';

import type { StreamState } from '../api/event-stream';

// The open run: its event log as received so far, and what the user is looking at. The
// log is the only run data kept here; everything shown is derived from it by the pure
// functions in ./selectors.

export interface RunStoreState {
  runId: string | null;
  /** Contiguous from seq 0. */
  events: readonly BoardEvent[];
  stream: StreamState | { kind: 'idle' };
  /** The round being replayed, or null to follow the head of the log. */
  cursor: number | null;
  selectedEntryId: string | null;
}

export interface RunStoreActions {
  /** Start afresh on `runId` (or on nothing). */
  open: (runId: string | null) => void;
  /** Take the next event; one already held is ignored, one out of order is refused. */
  append: (runId: string, event: BoardEvent) => void;
  setStream: (runId: string, stream: StreamState) => void;
  setCursor: (cursor: number | null) => void;
  selectEntry: (entryId: string | null) => void;
}

export type RunStore = RunStoreState & RunStoreActions;

const empty: RunStoreState = {
  runId: null,
  events: [],
  stream: { kind: 'idle' },
  cursor: null,
  selectedEntryId: null,
};

export const createRunStore = () =>
  create<RunStore>((set) => ({
    ...empty,
    open: (runId) => {
      set({ ...empty, runId });
    },
    append: (runId, event) => {
      set((state) => {
        // A stream that outlived its run's page, or a replayed event after a reconnect.
        if (state.runId !== runId || event.seq < state.events.length) return state;
        if (event.seq > state.events.length) {
          return {
            stream: {
              kind: 'failed',
              message: `The event stream skipped from event ${String(state.events.length)} to ${String(event.seq)}; reload to read the log again.`,
            },
          };
        }
        return { events: [...state.events, event] };
      });
    },
    setStream: (runId, stream) => {
      set((state) => {
        if (state.runId !== runId) return state;
        // A gap already reported is not papered over by a later "open".
        if (state.stream.kind === 'failed' && stream.kind !== 'failed') return state;
        return { stream };
      });
    },
    setCursor: (cursor) => {
      set({ cursor });
    },
    selectEntry: (selectedEntryId) => {
      set({ selectedEntryId });
    },
  }));

export const useRunStore = createRunStore();
