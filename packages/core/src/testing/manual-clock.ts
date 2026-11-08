import type { Clock } from '../ports/clock';

// 2026-01-01T00:00:00.000Z — a fixed, obviously-fake epoch for tests.
export const TEST_EPOCH_MS = 1_767_225_600_000;

export class ManualClock implements Clock {
  #ms: number;

  constructor(startMs: number = TEST_EPOCH_MS) {
    this.#ms = startMs;
  }

  nowMs(): number {
    return this.#ms;
  }

  advance(ms: number): void {
    this.#ms += ms;
  }
}
