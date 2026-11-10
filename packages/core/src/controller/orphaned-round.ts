import { addUsage, zeroUsage, type Usage } from '../schemas/common';
import type { BoardEvent } from '../schemas/event';

/** A round a log shows started and never finished: what a host that died mid-round left. */
export interface OrphanedRound {
  round: number;
  /** Agent entries committed before the process stopped (human notes are not counted). */
  newEntries: number;
  /** The usage those entries carry; calls that never reached a commit are in the trace only. */
  usage: Usage;
}

/**
 * The round left in flight at the end of a log, or null when every started round has
 * completed or been abandoned. Recovery turns the result into a `round_abandoned` event
 * so the round counts as used and the resumed run goes on from the next number.
 */
export const orphanedRound = (events: readonly BoardEvent[]): OrphanedRound | null => {
  let inFlight: number | null = null;
  for (const event of events) {
    if (event.type === 'round_started') inFlight = event.round;
    else if (
      (event.type === 'round_completed' || event.type === 'round_abandoned') &&
      event.round === inFlight
    ) {
      inFlight = null;
    }
  }
  if (inFlight === null) return null;
  const round = inFlight;
  const committed = events.flatMap((e) =>
    e.type === 'entry_committed' && e.round === round && e.entry.author !== 'human'
      ? [e.entry]
      : [],
  );
  return {
    round,
    newEntries: committed.length,
    usage: committed.reduce((total, entry) => addUsage(total, entry.usage), zeroUsage()),
  };
};
