import type { BoardEventType } from '@team/core';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';

import { openEventStream } from '../api/event-stream';
import { refreshRunData } from '../api/queries';
import { useRunStore } from './run-store';

// Connects the open run's event stream to the store for as long as a component shows that
// run, and tells the request/response queries when the stream reports something they show.

/** Events after which the run list, the trace or the month's spend may read differently. */
const REFRESH_AFTER: ReadonlySet<BoardEventType> = new Set([
  'round_completed',
  'agent_failed',
  'run_paused',
  'run_resumed',
  'run_terminated',
]);

/** A finished run replays its whole log at once; one refresh at the end of the burst will do. */
const REFRESH_DEBOUNCE_MS = 150;

export const useRunStream = (runId: string | null): void => {
  const queryClient = useQueryClient();
  useEffect(() => {
    const store = useRunStore.getState();
    store.open(runId);
    if (runId === null) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const close = openEventStream(runId, {
      onEvent: (event) => {
        useRunStore.getState().append(runId, event);
        if (!REFRESH_AFTER.has(event.type)) return;
        clearTimeout(timer);
        timer = setTimeout(() => {
          refreshRunData(queryClient, runId);
        }, REFRESH_DEBOUNCE_MS);
      },
      onState: (state) => {
        useRunStore.getState().setStream(runId, state);
      },
    });
    return () => {
      clearTimeout(timer);
      close();
    };
  }, [runId, queryClient]);
};
