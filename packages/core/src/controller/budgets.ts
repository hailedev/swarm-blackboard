import type { Clock } from '../ports/clock';
import { addUsage, totalTokens, zeroUsage, type Usage } from '../schemas/common';
import type { RunConfig } from '../schemas/run-config';
import type { RunBudgetReason } from '../schemas/run-end';

export type ReservationId = number;

/** What a tracker picks up from a run's log when a paused run is rehydrated. */
export interface BudgetSnapshot {
  usage: Usage;
  rounds: number;
  /** Wall-clock already consumed while the run was active. */
  elapsedMs: number;
  /** Whether the run is active (the clock runs) or paused (it does not). */
  running: boolean;
}

// Hard limits, enforced in code (CLAUDE.md architecture rule 4). The controller asks
// `exceeded()` before every round and after each round's model calls, and reserves the
// worst-case cost of every call before dispatching it (docs/budget-guardrails.md §2) so
// that parallel calls cannot jointly overshoot the cap. Wall-clock only counts while the
// run is active: a run paused for the month must not time out on resume.
export class BudgetTracker {
  #usage: Usage;
  #rounds: number;
  readonly #reservations = new Map<ReservationId, number>();
  #nextReservation: ReservationId = 1;
  #accumulatedMs: number;
  #activeSinceMs: number | null;
  readonly #config: RunConfig;
  readonly #clock: Clock;

  constructor(config: RunConfig, clock: Clock, snapshot?: BudgetSnapshot) {
    this.#config = config;
    this.#clock = clock;
    this.#usage = snapshot?.usage ?? zeroUsage();
    this.#rounds = snapshot?.rounds ?? 0;
    this.#accumulatedMs = snapshot?.elapsedMs ?? 0;
    this.#activeSinceMs = (snapshot?.running ?? true) ? clock.nowMs() : null;
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

  /** Stop the wall clock while the run is paused. */
  pause(): void {
    if (this.#activeSinceMs === null) return;
    this.#accumulatedMs += Math.max(0, this.#clock.nowMs() - this.#activeSinceMs);
    this.#activeSinceMs = null;
  }

  /** Start the wall clock again. */
  resume(): void {
    if (this.#activeSinceMs === null) this.#activeSinceMs = this.#clock.nowMs();
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
    const active =
      this.#activeSinceMs === null ? 0 : Math.max(0, this.#clock.nowMs() - this.#activeSinceMs);
    return this.#accumulatedMs + active;
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
