import type { Clock } from '../ports/clock';
import { addUsage, totalTokens, zeroUsage, type Usage } from '../schemas/common';
import type { RunConfig } from '../schemas/run-config';
import type { RunBudgetReason } from '../schemas/run-end';

export type ReservationId = number;

// Hard limits, enforced in code (CLAUDE.md architecture rule 4). The controller asks
// `exceeded()` before every round and after each round's model calls, and reserves the
// worst-case cost of every call before dispatching it (docs/budget-guardrails.md §2) so
// that parallel calls cannot jointly overshoot the cap.
export class BudgetTracker {
  #usage: Usage = zeroUsage();
  #rounds = 0;
  readonly #reservations = new Map<ReservationId, number>();
  #nextReservation: ReservationId = 1;
  readonly #startMs: number;
  readonly #config: RunConfig;
  readonly #clock: Clock;

  constructor(config: RunConfig, clock: Clock) {
    this.#config = config;
    this.#clock = clock;
    this.#startMs = clock.nowMs();
  }

  recordRound(): void {
    this.#rounds += 1;
  }

  recordUsage(usage: Usage): void {
    this.#usage = addUsage(this.#usage, usage);
  }

  /** Hold `worstCaseUsd` against the cap until the call settles or is released. */
  reserve(worstCaseUsd: number): ReservationId {
    const id = this.#nextReservation;
    this.#nextReservation += 1;
    this.#reservations.set(id, worstCaseUsd);
    return id;
  }

  /** Replace a reservation with what the call actually cost. */
  settle(id: ReservationId, usage: Usage): void {
    this.#reservations.delete(id);
    this.recordUsage(usage);
  }

  /** Drop a reservation for a call that never consumed anything. */
  release(id: ReservationId): void {
    this.#reservations.delete(id);
  }

  get rounds(): number {
    return this.#rounds;
  }

  get usage(): Usage {
    return this.#usage;
  }

  get reservedUsd(): number {
    let total = 0;
    for (const amount of this.#reservations.values()) total += amount;
    return total;
  }

  /** Dollars not yet spent or reserved. */
  remainingUsd(): number {
    return Math.max(0, this.#config.maxCostUsd - this.#usage.costUsd - this.reservedUsd);
  }

  elapsedMs(): number {
    return Math.max(0, this.#clock.nowMs() - this.#startMs);
  }

  /** The first exhausted limit, in a fixed order, or null while all budgets have room. */
  exceeded(): RunBudgetReason | null {
    if (this.#rounds >= this.#config.maxRounds) return 'budget_rounds';
    if (totalTokens(this.#usage) >= this.#config.maxTokens) return 'budget_tokens';
    if (this.#usage.costUsd >= this.#config.maxCostUsd) return 'budget_cost';
    if (this.elapsedMs() >= this.#config.maxWallClockMs) return 'budget_time';
    return null;
  }
}
