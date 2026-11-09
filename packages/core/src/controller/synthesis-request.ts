import type { BoardEvent } from '../schemas/event';

/**
 * Whether a synthesis the user asked for is still owed (docs/PLAN.md §2.3, ADR-0011).
 *
 * A `synthesis_requested` event is served by the first round that starts after it and
 * completes. A round already in flight when the request arrived does not serve it, and
 * neither does a round that started and never completed because its host died: that
 * round runs again after the restart, and its second `round_started` is the one that counts.
 *
 * The controller follows the same rule while it runs, so this fold is what a rehydrated
 * controller starts from and what the UI shows.
 */
export const synthesisPending = (events: readonly BoardEvent[]): boolean => {
  let requestedSeq: number | null = null;
  const startedSeq = new Map<number, number>();
  for (const event of events) {
    switch (event.type) {
      case 'synthesis_requested':
        requestedSeq ??= event.seq;
        break;
      case 'round_started':
        startedSeq.set(event.round, event.seq);
        break;
      case 'round_completed': {
        const started = startedSeq.get(event.round);
        if (requestedSeq !== null && started !== undefined && started > requestedSeq) {
          requestedSeq = null;
        }
        break;
      }
      default:
        break;
    }
  }
  return requestedSeq !== null;
};
