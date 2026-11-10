import {
  addUsage,
  AGENT_ROLES,
  buildBoardView,
  totalTokens,
  zeroUsage,
  type AgentFailureReason,
  type AgentRole,
  type BoardEvent,
  type BoardView,
  type RunConfig,
  type RunEndReason,
  type RunProfile,
  type Usage,
} from '@team/core';
import type { ModelCallSummary, RunRecordStatus } from '@team/server/api';

import { TYPE_LABEL } from '../lib/entry-types';
import { compact, excerpt, usd } from '../lib/format';
import { FAILURE_LABEL, REASON_TEXT, STATUS_LABEL } from '../lib/reasons';

// Everything the UI shows about a run is a pure function of its event log (ADR-0011): the
// log is the source of truth, and replay is the same functions over a prefix of it.

/** A round that ended, by finishing or by being abandoned when its host died. */
const roundEnded = (
  e: BoardEvent,
): e is Extract<BoardEvent, { type: 'round_completed' | 'round_abandoned' }> =>
  e.type === 'round_completed' || e.type === 'round_abandoned';

/** The number of the last round that ended; 0 before any has. */
export const completedRounds = (events: readonly BoardEvent[]): number =>
  events.reduce((max, e) => (roundEnded(e) ? Math.max(max, e.round) : max), 0);

/**
 * The log as it stood once `round` had completed and before the next round started.
 * Round 0 is the board before any round: the problem, and anything the user added first.
 */
export const eventsThrough = (
  events: readonly BoardEvent[],
  round: number,
): readonly BoardEvent[] => {
  const next = events.findIndex((e) => e.type === 'round_started' && e.round > round);
  return next === -1 ? events : events.slice(0, next);
};

/** The events a view at `cursor` is built from: all of them when following the head. */
export const eventsAt = (
  events: readonly BoardEvent[],
  cursor: number | null,
): readonly BoardEvent[] => (cursor === null ? events : eventsThrough(events, cursor));

export const boardAt = (
  runId: string,
  events: readonly BoardEvent[],
  cursor: number | null,
): BoardView => buildBoardView(runId, eventsAt(events, cursor));

export interface RunState {
  runId: string;
  status: RunRecordStatus;
  /** Null exactly while the run is running. */
  reason: RunEndReason | null;
  problem: string;
  config: RunConfig;
  profile: RunProfile | null;
  startedAt: string;
  /** Highest round that has started. */
  round: number;
  completedRounds: number;
  /** A round has started and not completed, and the run is running. */
  roundInFlight: boolean;
}

export const runStateOf = (events: readonly BoardEvent[]): RunState | undefined => {
  const first = events[0];
  if (first === undefined || first.type !== 'run_started') return undefined;
  let status: RunRecordStatus = 'running';
  let reason: RunEndReason | null = null;
  let round = 0;
  let completed = 0;
  for (const event of events) {
    switch (event.type) {
      case 'round_started':
        round = Math.max(round, event.round);
        break;
      case 'round_completed':
      case 'round_abandoned':
        completed = Math.max(completed, event.round);
        break;
      case 'run_paused':
        status = 'paused';
        reason = event.reason;
        break;
      case 'run_resumed':
        status = 'running';
        reason = null;
        break;
      case 'run_terminated':
        status = event.status;
        reason = event.reason;
        break;
      default:
        break;
    }
  }
  return {
    runId: first.runId,
    status,
    reason,
    problem: first.problemEntry.content,
    config: first.config,
    profile: first.profile,
    startedAt: first.at,
    round,
    completedRounds: completed,
    roundInFlight: status === 'running' && round > completed,
  };
};

/** What the run has used: the sum of every round that ended. */
export const usageOf = (events: readonly BoardEvent[]): Usage =>
  events.reduce((total, e) => (roundEnded(e) ? addUsage(total, e.usage) : total), zeroUsage());

/**
 * Wall-clock the run has consumed while active. A pause or an end states the figure the
 * controller measured; while the run is running the time since it (re)started is added.
 */
export const elapsedMsOf = (events: readonly BoardEvent[], nowMs: number): number => {
  let total = 0;
  let runningSince: number | null = null;
  for (const event of events) {
    switch (event.type) {
      case 'run_started':
      case 'run_resumed':
        runningSince = Date.parse(event.at);
        break;
      case 'run_paused':
      case 'run_terminated':
        total = event.totals.elapsedMs;
        runningSince = null;
        break;
      default:
        break;
    }
  }
  return runningSince === null ? total : total + Math.max(0, nowMs - runningSince);
};

/** When the last event of a log happened: the "now" of a replayed moment. */
export const lastEventMs = (events: readonly BoardEvent[]): number => {
  const last = events.at(-1);
  return last === undefined ? 0 : Date.parse(last.at);
};

export type AgentActivity = 'idle' | 'running' | 'failed';

export interface AgentState {
  role: AgentRole;
  activity: AgentActivity;
  /** Rounds in which the agent was selected. */
  rounds: number;
  lastSelectedRound: number | null;
  /** Why its trigger last said it was eligible. */
  lastEligibility: string | null;
  /** What went wrong the last time it was selected, if anything did. */
  failure: { round: number; reason: AgentFailureReason; detail: string } | null;
}

const isRole = (id: string): id is AgentRole => (AGENT_ROLES as readonly string[]).includes(id);

export const agentStatesOf = (events: readonly BoardEvent[]): AgentState[] => {
  const states = new Map<AgentRole, AgentState>(
    AGENT_ROLES.map((role) => [
      role,
      {
        role,
        activity: 'idle',
        rounds: 0,
        lastSelectedRound: null,
        lastEligibility: null,
        failure: null,
      },
    ]),
  );
  let inFlight: number | null = null;
  let running = false;
  for (const event of events) {
    switch (event.type) {
      case 'run_started':
      case 'run_resumed':
        running = true;
        break;
      case 'run_paused':
      case 'run_terminated':
        running = false;
        inFlight = null;
        break;
      case 'round_started':
        inFlight = event.round;
        break;
      case 'round_completed':
      case 'round_abandoned':
        inFlight = null;
        break;
      case 'agents_selected':
        for (const record of event.eligible) {
          if (!isRole(record.agentId)) continue;
          const state = states.get(record.agentId);
          if (state !== undefined) state.lastEligibility = record.reason;
        }
        for (const id of event.selected) {
          if (!isRole(id)) continue;
          const state = states.get(id);
          if (state === undefined) continue;
          state.rounds += 1;
          state.lastSelectedRound = event.round;
          state.failure = null;
        }
        break;
      case 'agent_failed': {
        if (!isRole(event.agentId)) break;
        const state = states.get(event.agentId);
        if (state !== undefined) {
          state.failure = { round: event.round, reason: event.reason, detail: event.detail };
        }
        break;
      }
      default:
        break;
    }
  }
  return [...states.values()].map((state) => ({
    ...state,
    activity:
      running && inFlight !== null && state.lastSelectedRound === inFlight
        ? 'running'
        : state.failure !== null && state.failure.round === state.lastSelectedRound
          ? 'failed'
          : 'idle',
  }));
};

export interface AgentSpend {
  calls: number;
  costUsd: number;
  tokens: number;
  /** The part of the output tokens spent thinking (ADR-0013). */
  reasoningTokens: number;
  latencyMs: number;
}

/** Calls, spend and time per role, from the trace; `throughRound` bounds a replayed view. */
export const agentSpendOf = (
  calls: readonly ModelCallSummary[],
  throughRound: number | null,
): Map<string, AgentSpend> => {
  const spend = new Map<string, AgentSpend>();
  for (const call of calls) {
    if (throughRound !== null && call.round !== null && call.round > throughRound) continue;
    const current = spend.get(call.role) ?? {
      calls: 0,
      costUsd: 0,
      tokens: 0,
      reasoningTokens: 0,
      latencyMs: 0,
    };
    spend.set(call.role, {
      calls: current.calls + 1,
      costUsd: current.costUsd + (call.costUsd ?? 0),
      tokens:
        current.tokens +
        (call.inputTokens ?? 0) +
        (call.outputTokens ?? 0) +
        (call.cacheReadTokens ?? 0) +
        (call.cacheWriteTokens ?? 0),
      reasoningTokens: current.reasoningTokens + (call.reasoningTokens ?? 0),
      latencyMs: current.latencyMs + call.latencyMs,
    });
  }
  return spend;
};

export type FeedTone = 'neutral' | 'accent' | 'good' | 'warning' | 'critical';

export interface FeedLine {
  seq: number;
  at: string;
  tone: FeedTone;
  title: string;
  detail: string | null;
  /** The entry the line is about, so the feed can open it on the board. */
  entryId: string | null;
}

const feedLine = (
  event: BoardEvent,
  tone: FeedTone,
  title: string,
  detail: string | null = null,
  entryId: string | null = null,
): FeedLine => ({ seq: event.seq, at: event.at, tone, title, detail, entryId });

/** One line per event, in order. `view` must be the fold of the same events (handles). */
export const feedOf = (events: readonly BoardEvent[], view: BoardView): FeedLine[] =>
  events.map((event): FeedLine => {
    switch (event.type) {
      case 'run_started':
        return feedLine(
          event,
          'neutral',
          'Run started',
          `${event.profile === null ? 'no profile' : `profile ${event.profile.name}`} · up to ${String(event.config.maxRounds)} rounds · cap ${usd(event.config.maxCostUsd)}`,
        );
      case 'round_started':
        return feedLine(event, 'neutral', `Round ${String(event.round)} started`);
      case 'agents_selected':
        return feedLine(
          event,
          'neutral',
          event.selected.length === 0
            ? 'No agent selected'
            : `Selected: ${event.selected.join(', ')}`,
          event.selected
            .map((id) => {
              const record = event.eligible.find((e) => e.agentId === id);
              return record === undefined ? id : `${id}: ${record.reason}`;
            })
            .join(' · ') || null,
        );
      case 'entry_committed': {
        const { entry } = event;
        const handle = view.handleOf(entry.id) ?? '?';
        return feedLine(
          event,
          entry.type === 'synthesis' ? 'good' : entry.author === 'human' ? 'accent' : 'neutral',
          `${handle} · ${TYPE_LABEL[entry.type]} by ${entry.author === 'human' ? 'you' : entry.author}`,
          excerpt(entry.content, 160),
          entry.id,
        );
      }
      case 'agent_failed':
        return feedLine(
          event,
          event.reason === 'invalid_links' ? 'warning' : 'critical',
          `${event.agentId} failed: ${FAILURE_LABEL[event.reason]}`,
          event.detail === '' ? null : event.detail,
        );
      case 'round_completed':
        return feedLine(
          event,
          'neutral',
          `Round ${String(event.round)} completed`,
          `${String(event.newEntries)} new ${event.newEntries === 1 ? 'entry' : 'entries'} · ${usd(event.usage.costUsd)} · ${compact(totalTokens(event.usage))} tokens`,
        );
      case 'round_abandoned':
        return feedLine(
          event,
          'warning',
          `Round ${String(event.round)} abandoned`,
          `The process running it stopped${
            event.newEntries === 0
              ? ''
              : ` after ${String(event.newEntries)} ${event.newEntries === 1 ? 'entry' : 'entries'}`
          }; the run continues at round ${String(event.round + 1)}.`,
        );
      case 'synthesis_requested':
        return feedLine(
          event,
          'accent',
          'You asked for a synthesis',
          'The Synthesizer runs in the next round to start.',
        );
      case 'budget_warning':
        return feedLine(
          event,
          'warning',
          'Monthly budget warning',
          `${usd(event.spentUsd, 2)} of ${usd(event.limitUsd, 2)} spent this month`,
        );
      case 'run_paused':
        return feedLine(
          event,
          'warning',
          `Paused — ${REASON_TEXT[event.reason].label}`,
          REASON_TEXT[event.reason].detail,
        );
      case 'run_resumed':
        return feedLine(
          event,
          'accent',
          'Resumed',
          `It had been paused: ${REASON_TEXT[event.from].label}.`,
        );
      case 'run_terminated':
        return feedLine(
          event,
          event.status === 'failed'
            ? 'critical'
            : event.reason === 'completed'
              ? 'good'
              : 'neutral',
          `${STATUS_LABEL[event.status]} — ${REASON_TEXT[event.reason].label}`,
          REASON_TEXT[event.reason].detail,
        );
    }
  });
