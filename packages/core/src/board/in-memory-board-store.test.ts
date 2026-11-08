import { describe, expect, it } from 'vitest';

import type { BoardEvent } from '../schemas/event';
import { sequentialId } from '../testing/sequential-id-generator';
import { InMemoryBoardStore } from './in-memory-board-store';

const roundStarted = (runId: string, seq: number, round: number): BoardEvent => ({
  id: sequentialId(1000 + seq),
  runId,
  seq,
  at: '2026-01-01T00:00:00.000Z',
  type: 'round_started',
  round,
});

describe('InMemoryBoardStore', () => {
  const runA = sequentialId(1);
  const runB = sequentialId(2);

  it('appends contiguous events and returns them in order', async () => {
    const store = new InMemoryBoardStore();
    expect((await store.append(roundStarted(runA, 0, 1))).ok).toBe(true);
    expect((await store.append(roundStarted(runA, 1, 2))).ok).toBe(true);
    const events = await store.eventsFor(runA);
    expect(events.map((e) => e.seq)).toEqual([0, 1]);
  });

  it('rejects an out-of-order seq without storing it', async () => {
    const store = new InMemoryBoardStore();
    await store.append(roundStarted(runA, 0, 1));
    const result = await store.append(roundStarted(runA, 5, 2));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toEqual({ kind: 'out_of_order', runId: runA, expected: 1, actual: 5 });
    }
    expect((await store.eventsFor(runA)).length).toBe(1);
  });

  it('isolates runs and lists them', async () => {
    const store = new InMemoryBoardStore();
    await store.append(roundStarted(runA, 0, 1));
    await store.append(roundStarted(runB, 0, 1));
    expect((await store.eventsFor(runA)).length).toBe(1);
    expect((await store.eventsFor(runB)).length).toBe(1);
    expect(await store.eventsFor(sequentialId(3))).toEqual([]);
    expect(store.runIds()).toEqual([runA, runB]);
  });

  it('hands out copies, so callers cannot mutate the log', async () => {
    const store = new InMemoryBoardStore();
    await store.append(roundStarted(runA, 0, 1));
    const events = (await store.eventsFor(runA)) as BoardEvent[];
    events.pop();
    expect((await store.eventsFor(runA)).length).toBe(1);
  });
});
