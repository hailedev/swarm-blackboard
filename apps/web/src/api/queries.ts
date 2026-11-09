import type { HumanNotePriority } from '@team/core';
import type { RunRecord, StartRunBody } from '@team/server/api';
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';

import { api } from './client';

// Request/response data (TanStack Query). The open run's board is not here: it comes from
// the event stream (../state). These queries are refreshed when the stream says something
// they show has changed.

export const queryKeys = {
  runs: ['runs'] as const,
  profiles: ['profiles'] as const,
  budget: ['budget'] as const,
  trace: (runId: string) => ['trace', runId] as const,
  call: (runId: string, callId: string) => ['trace', runId, callId] as const,
};

/** How often the run list is re-read while a run is running somewhere. */
const RUNS_POLL_MS = 3_000;

export const useRuns = () =>
  useQuery({
    queryKey: queryKeys.runs,
    queryFn: api.runs,
    refetchInterval: (query) =>
      query.state.data?.some((run) => run.status === 'running') === true ? RUNS_POLL_MS : false,
  });

export const useProfiles = () =>
  useQuery({ queryKey: queryKeys.profiles, queryFn: api.profiles, staleTime: Infinity });

export const useBudget = () => useQuery({ queryKey: queryKeys.budget, queryFn: api.budget });

export const useTrace = (runId: string) =>
  useQuery({ queryKey: queryKeys.trace(runId), queryFn: () => api.trace(runId) });

/** One call in full; a traced call never changes, so it is read once. */
export const useCall = (runId: string, callId: string | null) =>
  useQuery({
    queryKey: queryKeys.call(runId, callId ?? ''),
    queryFn: () => api.call(runId, callId ?? ''),
    enabled: callId !== null,
    staleTime: Infinity,
  });

/** What a run event can change outside the board: the list, the trace, the month's spend. */
export const refreshRunData = (queryClient: QueryClient, runId: string): void => {
  void queryClient.invalidateQueries({ queryKey: queryKeys.runs });
  void queryClient.invalidateQueries({ queryKey: queryKeys.trace(runId), exact: true });
  void queryClient.invalidateQueries({ queryKey: queryKeys.budget });
};

export const useStartRun = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: StartRunBody) => api.start(body),
    onSuccess: (record) => {
      // Put the new run in the list at once, so opening it does not wait for a refetch.
      queryClient.setQueryData<RunRecord[]>(queryKeys.runs, (runs) => [
        record,
        ...(runs ?? []).filter((run) => run.id !== record.id),
      ]);
      void queryClient.invalidateQueries({ queryKey: queryKeys.runs });
      void queryClient.invalidateQueries({ queryKey: queryKeys.budget });
    },
  });
};

export type RunAction = 'pause' | 'resume' | 'stop' | 'synthesize';

/** Pause, resume, stop or force a synthesis; the stream reports what came of it. */
export const useRunAction = (runId: string) => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (action: RunAction) => api[action](runId),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.runs });
    },
  });
};

export const useInjectNote = (runId: string) =>
  useMutation({
    mutationFn: (note: { content: string; priority: HumanNotePriority }) => api.inject(runId, note),
  });
