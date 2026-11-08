import type { Clock } from '../ports/clock';
import { addUsage, zeroUsage, type Usage } from '../schemas/common';
import type { RunConfig } from '../schemas/run-config';

export type BudgetLimit = 'rounds' | 'tokens' | 'cost' | 'wall_clock';

// Hard limits, enforced in code (CLAUDE.md architecture rule 4). The controller
// asks `exceeded()` before every round and again after each round's model calls.
export class BudgetTracker {
  #usage: Usage = zeroUsage();
  #rounds = 0;
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

  get rounds(): number {
    return this.#rounds;
  }

  get usage(): Usage {
    return this.#usage;
  }

  elapsedMs(): number {
    return Math.max(0, this.#clock.nowMs() - this.#startMs);
  }

  /** The first exhausted limit, in a fixed order, or null while all budgets have room. */
  exceeded(): BudgetLimit | null {
    if (this.#rounds >= this.#config.maxRounds) return 'rounds';
    const tokens = this.#usage.inputTokens + this.#usage.outputTokens;
    if (tokens >= this.#config.maxTotalTokens) return 'tokens';
    if (this.#usage.costUsd >= this.#config.maxCostUsd) return 'cost';
    if (this.elapsedMs() >= this.#config.maxWallClockMin * 60_000) return 'wall_clock';
    return null;
  }
}
