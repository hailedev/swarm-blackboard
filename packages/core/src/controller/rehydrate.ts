import { noControlFlags, type ControlFlags } from '../agents/agent';
import { buildBoardView } from '../board/board-view';
import { err, ok, type Result } from '../ports/result';
import { addUsage, zeroUsage, type Usage } from '../schemas/common';
import type { BoardEvent } from '../schemas/event';
import type { RunProfile } from '../schemas/roster';
import type { RunConfig } from '../schemas/run-config';
import type { PauseReason, TerminalReason, TerminalStatus } from '../schemas/run-end';
import { ConflictTracker } from './conflict';
import { synthesisPending } from './synthesis-request';

// A controller's state is a fold over its own event log, so a paused run can be picked up
// by a fresh process: the month rolls over, the server restarts, the run continues. This
// module replays what `createController` would have accumulated round by round; the
// controller then starts from the result instead of from an empty board.

/** How a run has stopped, for now or for good; narrower than RunEnd so the two stay apart. */
export type RunEndState =
  { status: 'paused'; reason: PauseReason } | { status: TerminalStatus; reason: TerminalReason };

export interface RehydratedState {
  runId: string;
  config: RunConfig;
  profile: RunProfile | null;
  events: readonly BoardEvent[];
  completedRounds: number;
  /** Agents selected per completed round, oldest first (the selection diversity window). */
  history: readonly (readonly string[])[];
  conflicts: ConflictTracker;
  flags: ControlFlags;
  /** A synthesis the user asked for that no round has served yet. */
  synthesisPending: boolean;
  reframeUsed: boolean;
  consecutiveEmptyRounds: number;
  monthlyWarningSent: boolean;
  usage: Usage;
  /** Wall-clock the run had consumed while active. */
  elapsedMs: number;
  ended: RunEndState | null;
}

export type RehydrateError = { kind: 'empty_log' } | { kind: 'no_run_started' };

export const rehydrate = (
  events: readonly BoardEvent[],
): Result<RehydratedState, RehydrateError> => {
  const first = events[0];
  if (first === undefined) return err({ kind: 'empty_log' });
  if (first.type !== 'run_started') return err({ kind: 'no_run_started' });
  const { runId, config } = first;

  const conflicts = new ConflictTracker();
  const selectedByRound = new Map<number, readonly string[]>();
  const history: (readonly string[])[] = [];
  let flags: ControlFlags = noControlFlags();
  let completedRounds = 0;
  let usage = zeroUsage();
  let consecutiveEmptyRounds = 0;
  let reframeUsed = false;
  let monthlyWarningSent = false;
  let ended: RunEndState | null = null;
  let elapsedMs: number | null = null;

  // The end of a round, as the controller saw it: the round's selection joins the diversity
  // window, its usage the totals, and the conflict check runs on the board as it stood then.
  // `synthesisForced` is on only while the round that serves a request is in flight; a
  // request still owed is `synthesisPending`, below.
  const closeRound = (round: number, roundUsage: Usage, index: number): void => {
    completedRounds = round;
    history.push(selectedByRound.get(round) ?? []);
    usage = addUsage(usage, roundUsage);
    const soFar = events.slice(0, index + 1);
    const critiqueTargets = new Set(
      soFar.flatMap((e) =>
        e.type === 'entry_committed' && e.round === round && e.entry.type === 'critique'
          ? [e.entry.payload.target]
          : [],
      ),
    );
    const assessment = conflicts.assess(buildBoardView(runId, soFar), critiqueTargets);
    flags = {
      ...noControlFlags(),
      criticForced: assessment.criticForced,
      decisionRequired: assessment.decisionRequired,
    };
  };

  // A plain loop, not forEach: the state below is reassigned here and TypeScript must see
  // that, or it narrows `ended` and `elapsedMs` to their initial values.
  for (const [index, event] of events.entries()) {
    switch (event.type) {
      case 'agents_selected':
        selectedByRound.set(event.round, event.selected);
        break;
      case 'round_abandoned':
        // The host died mid-round. The round counts as used; the stall rule is left alone,
        // since nothing is known about what the round would have produced.
        closeRound(event.round, event.usage, index);
        break;
      case 'round_completed': {
        closeRound(event.round, event.usage, index);
        consecutiveEmptyRounds = event.newEntries === 0 ? consecutiveEmptyRounds + 1 : 0;
        if (consecutiveEmptyRounds >= config.stallRounds && !reframeUsed) {
          reframeUsed = true;
          flags.stallDetected = true;
          consecutiveEmptyRounds = 0;
        }
        break;
      }
      case 'budget_warning':
        monthlyWarningSent = true;
        break;
      case 'run_paused':
        ended = { status: 'paused', reason: event.reason };
        elapsedMs = event.totals.elapsedMs;
        break;
      case 'run_resumed':
        ended = null;
        break;
      case 'run_terminated':
        ended = { status: event.status, reason: event.reason };
        elapsedMs = event.totals.elapsedMs;
        break;
      case 'run_started':
      case 'round_started':
      case 'entry_committed':
      case 'agent_failed':
      case 'synthesis_requested':
        break;
    }
  }

  // A log that was never paused or ended belongs to a run cut off mid-way: count the time
  // between its first and last event as consumed.
  const last = events[events.length - 1] ?? first;
  return ok({
    runId,
    config,
    profile: first.profile,
    events,
    completedRounds,
    history,
    conflicts,
    flags,
    synthesisPending: synthesisPending(events),
    reframeUsed,
    consecutiveEmptyRounds,
    monthlyWarningSent,
    usage,
    elapsedMs: elapsedMs ?? Math.max(0, Date.parse(last.at) - Date.parse(first.at)),
    ended,
  });
};
