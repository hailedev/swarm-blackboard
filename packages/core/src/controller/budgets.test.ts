import { describe, expect, it } from 'vitest';

import { RunConfigSchema } from '../schemas/run-config';
import { ManualClock } from '../testing/manual-clock';
import { BudgetTracker } from './budgets';

const config = (overrides = {}) => RunConfigSchema.parse(overrides);

describe('BudgetTracker', () => {
  it('has room by default and accumulates usage', () => {
    const tracker = new BudgetTracker(config(), new ManualClock());
    expect(tracker.exceeded()).toBeNull();
    tracker.recordUsage({ inputTokens: 10, outputTokens: 5, costUsd: 0.01 });
    tracker.recordUsage({ inputTokens: 1, outputTokens: 1, costUsd: 0.02 });
    expect(tracker.usage).toEqual({ inputTokens: 11, outputTokens: 6, costUsd: 0.03 });
    expect(tracker.rounds).toBe(0);
  });

  it('stops at the round limit', () => {
    const tracker = new BudgetTracker(config({ maxRounds: 2 }), new ManualClock());
    tracker.recordRound();
    expect(tracker.exceeded()).toBeNull();
    tracker.recordRound();
    expect(tracker.exceeded()).toBe('rounds');
  });

  it('stops at the token limit, counting input and output', () => {
    const tracker = new BudgetTracker(config({ maxTotalTokens: 100 }), new ManualClock());
    tracker.recordUsage({ inputTokens: 60, outputTokens: 39, costUsd: 0 });
    expect(tracker.exceeded()).toBeNull();
    tracker.recordUsage({ inputTokens: 0, outputTokens: 1, costUsd: 0 });
    expect(tracker.exceeded()).toBe('tokens');
  });

  it('stops at the cost limit', () => {
    const tracker = new BudgetTracker(config({ maxCostUsd: 0.5 }), new ManualClock());
    tracker.recordUsage({ inputTokens: 0, outputTokens: 0, costUsd: 0.49 });
    expect(tracker.exceeded()).toBeNull();
    tracker.recordUsage({ inputTokens: 0, outputTokens: 0, costUsd: 0.01 });
    expect(tracker.exceeded()).toBe('cost');
  });

  it('stops at the wall-clock limit using the injected clock', () => {
    const clock = new ManualClock();
    const tracker = new BudgetTracker(config({ maxWallClockMin: 1 }), clock);
    clock.advance(59_999);
    expect(tracker.exceeded()).toBeNull();
    expect(tracker.elapsedMs()).toBe(59_999);
    clock.advance(1);
    expect(tracker.exceeded()).toBe('wall_clock');
  });

  it('reports limits in a fixed order when several are exhausted', () => {
    const clock = new ManualClock();
    const tracker = new BudgetTracker(
      config({ maxRounds: 1, maxTotalTokens: 1, maxCostUsd: 0, maxWallClockMin: 1 }),
      clock,
    );
    clock.advance(120_000);
    expect(tracker.exceeded()).toBe('cost');
    tracker.recordUsage({ inputTokens: 1, outputTokens: 0, costUsd: 0 });
    expect(tracker.exceeded()).toBe('tokens');
    tracker.recordRound();
    expect(tracker.exceeded()).toBe('rounds');
  });
});
