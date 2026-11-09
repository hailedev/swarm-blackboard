import { describe, expect, it } from 'vitest';

import { zeroUsage, type Usage } from '../schemas/common';
import { RunConfigSchema } from '../schemas/run-config';
import { ManualClock } from '../testing/manual-clock';
import { BudgetTracker } from './budgets';

const config = (overrides = {}) => RunConfigSchema.parse(overrides);

const usage = (partial: Partial<Usage>): Usage => ({ ...zeroUsage(), ...partial });

describe('BudgetTracker', () => {
  it('has room by default and accumulates every usage field', () => {
    const tracker = new BudgetTracker(config(), new ManualClock());
    expect(tracker.exceeded()).toBeNull();
    tracker.recordUsage(
      usage({ inputTokens: 10, outputTokens: 5, cacheReadTokens: 2, costUsd: 0.01 }),
    );
    tracker.recordUsage(
      usage({ inputTokens: 1, outputTokens: 1, cacheWriteTokens: 3, costUsd: 0.02 }),
    );
    expect(tracker.usage).toEqual({
      inputTokens: 11,
      outputTokens: 6,
      cacheReadTokens: 2,
      cacheWriteTokens: 3,
      costUsd: 0.03,
    });
    expect(tracker.rounds).toBe(0);
  });

  it('stops at the round limit', () => {
    const tracker = new BudgetTracker(config({ maxRounds: 2 }), new ManualClock());
    tracker.recordRound();
    expect(tracker.exceeded()).toBeNull();
    tracker.recordRound();
    expect(tracker.exceeded()).toBe('budget_rounds');
  });

  it('stops at the token limit, counting prompt, cache and output tokens', () => {
    const tracker = new BudgetTracker(config({ maxTokens: 100 }), new ManualClock());
    tracker.recordUsage(
      usage({ inputTokens: 50, cacheReadTokens: 10, cacheWriteTokens: 10, outputTokens: 29 }),
    );
    expect(tracker.exceeded()).toBeNull();
    tracker.recordUsage(usage({ outputTokens: 1 }));
    expect(tracker.exceeded()).toBe('budget_tokens');
  });

  it('stops at the cost limit', () => {
    const tracker = new BudgetTracker(config({ maxCostUsd: 0.5 }), new ManualClock());
    tracker.recordUsage(usage({ costUsd: 0.49 }));
    expect(tracker.exceeded()).toBeNull();
    tracker.recordUsage(usage({ costUsd: 0.01 }));
    expect(tracker.exceeded()).toBe('budget_cost');
  });

  it('stops at the wall-clock limit using the injected clock', () => {
    const clock = new ManualClock();
    const tracker = new BudgetTracker(config({ maxWallClockMs: 60_000 }), clock);
    clock.advance(59_999);
    expect(tracker.exceeded()).toBeNull();
    expect(tracker.elapsedMs()).toBe(59_999);
    clock.advance(1);
    expect(tracker.exceeded()).toBe('budget_time');
  });

  it('reports limits in a fixed order when several are exhausted', () => {
    const clock = new ManualClock();
    const tracker = new BudgetTracker(
      config({ maxRounds: 1, maxTokens: 1, maxCostUsd: 0, maxWallClockMs: 60_000 }),
      clock,
    );
    clock.advance(120_000);
    expect(tracker.exceeded()).toBe('budget_cost');
    tracker.recordUsage(usage({ inputTokens: 1 }));
    expect(tracker.exceeded()).toBe('budget_tokens');
    tracker.recordRound();
    expect(tracker.exceeded()).toBe('budget_rounds');
  });

  describe('reservations', () => {
    it('hold worst-case cost against the cap until settled with the actual usage', () => {
      const tracker = new BudgetTracker(config({ maxCostUsd: 0.1 }), new ManualClock());
      const first = tracker.reserve(0.04);
      const second = tracker.reserve(0.05);
      expect(tracker.reservedUsd).toBeCloseTo(0.09, 10);
      expect(tracker.remainingUsd()).toBeCloseTo(0.01, 10);

      tracker.settle(first, usage({ costUsd: 0.015 }));
      expect(tracker.reservedUsd).toBeCloseTo(0.05, 10);
      expect(tracker.usage.costUsd).toBeCloseTo(0.015, 10);
      expect(tracker.remainingUsd()).toBeCloseTo(0.035, 10);

      tracker.release(second);
      expect(tracker.reservedUsd).toBe(0);
      expect(tracker.remainingUsd()).toBeCloseTo(0.085, 10);
      expect(tracker.exceeded()).toBeNull();
    });

    it('never reports negative remaining budget', () => {
      const tracker = new BudgetTracker(config({ maxCostUsd: 0.01 }), new ManualClock());
      tracker.reserve(0.02);
      expect(tracker.remainingUsd()).toBe(0);
      tracker.recordUsage(usage({ costUsd: 0.5 }));
      expect(tracker.remainingUsd()).toBe(0);
      expect(tracker.exceeded()).toBe('budget_cost');
    });
  });
});
