import { describe, expect, it } from 'vitest';

import { defaultRunConfig, RunConfigSchema } from './run-config';

describe('RunConfigSchema', () => {
  it('fills the docs/PLAN.md §2.3 defaults', () => {
    expect(defaultRunConfig()).toEqual({
      maxRounds: 12,
      maxCostUsd: 2.0,
      maxWallClockMin: 15,
      maxTotalTokens: 400_000,
      parallelism: 2,
      synthesisThreshold: 0.8,
      synthesisFromRound: 8,
      stallRounds: 2,
    });
  });

  it('accepts partial overrides', () => {
    const config = RunConfigSchema.parse({ maxRounds: 3, parallelism: 1 });
    expect(config.maxRounds).toBe(3);
    expect(config.parallelism).toBe(1);
    expect(config.maxCostUsd).toBe(2.0);
  });

  it.each([
    ['zero rounds', { maxRounds: 0 }],
    ['zero parallelism', { parallelism: 0 }],
    ['negative cost', { maxCostUsd: -1 }],
    ['threshold above 1', { synthesisThreshold: 1.2 }],
    ['fractional rounds', { maxRounds: 2.5 }],
  ])('rejects %s', (_label, input) => {
    expect(RunConfigSchema.safeParse(input).success).toBe(false);
  });
});
