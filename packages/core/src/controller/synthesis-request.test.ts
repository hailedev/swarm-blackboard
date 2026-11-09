import { describe, expect, it } from 'vitest';

import { zeroUsage } from '../schemas/common';
import type { BoardEvent } from '../schemas/event';
import { sequentialId } from '../testing/sequential-id-generator';
import { synthesisPending } from './synthesis-request';

// The rule over the log: a request is served by the first round that starts after it and
// completes. Logs here hold only the three event types the rule reads.
type Step = ['requested' | 'started' | 'completed', number];

const log = (...steps: Step[]): BoardEvent[] =>
  steps.map(([kind, round], seq): BoardEvent => {
    const base = {
      id: sequentialId(seq + 10),
      runId: sequentialId(1),
      seq,
      at: '2026-01-01T00:00:00.000Z',
    };
    if (kind === 'requested') return { ...base, type: 'synthesis_requested', round };
    if (kind === 'started') return { ...base, type: 'round_started', round };
    return { ...base, type: 'round_completed', round, newEntries: 0, usage: zeroUsage() };
  });

/** Shifts the sequence numbers of a log fragment so it can follow another. */
const reseq =
  (offset: number) =>
  (event: BoardEvent): BoardEvent => ({ ...event, seq: event.seq + offset });

describe('synthesisPending', () => {
  it('is false without a request', () => {
    expect(synthesisPending([])).toBe(false);
    expect(synthesisPending(log(['started', 1], ['completed', 1]))).toBe(false);
  });

  it('is owed from the request until a round that started after it completes', () => {
    expect(synthesisPending(log(['requested', 0]))).toBe(true);
    expect(synthesisPending(log(['requested', 0], ['started', 1]))).toBe(true);
    expect(synthesisPending(log(['requested', 0], ['started', 1], ['completed', 1]))).toBe(false);
  });

  it('is not served by the round that was in flight when it arrived', () => {
    const midRound = log(['started', 1], ['requested', 0], ['completed', 1]);
    expect(synthesisPending(midRound)).toBe(true);
    expect(
      synthesisPending(
        log(['started', 1], ['requested', 0], ['completed', 1], ['started', 2], ['completed', 2]),
      ),
    ).toBe(false);
  });

  it('is not served by a round that never completed, and is by its re-run', () => {
    // The host died in round 2 after the request; the run was paused and resumed, and
    // round 2 started again.
    const orphaned = log(['started', 1], ['completed', 1], ['requested', 1], ['started', 2]);
    expect(synthesisPending(orphaned)).toBe(true);
    expect(
      synthesisPending([...orphaned, ...log(['started', 2], ['completed', 2]).map(reseq(4))]),
    ).toBe(false);
    // The orphaned round started before the request; only its re-run started after.
    const before = log(['started', 1], ['requested', 0]);
    expect(
      synthesisPending([...before, ...log(['started', 1], ['completed', 1]).map(reseq(2))]),
    ).toBe(false);
  });

  it('counts repeated requests once and a later one afresh', () => {
    expect(
      synthesisPending(log(['requested', 0], ['requested', 0], ['started', 1], ['completed', 1])),
    ).toBe(false);
    expect(
      synthesisPending(log(['requested', 0], ['started', 1], ['completed', 1], ['requested', 1])),
    ).toBe(true);
  });
});
