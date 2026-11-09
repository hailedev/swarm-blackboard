import { describe, expect, it } from 'vitest';

import { defaultRunConfig, RunConfigSchema } from './run-config';

describe('RunConfigSchema', () => {
  it('fills the docs/budget-guardrails.md §2 and §6 defaults', () => {
    expect(defaultRunConfig()).toEqual({
      maxRounds: 12,
      maxCostUsd: 0.25,
      maxTokens: 400_000,
      maxWallClockMs: 15 * 60_000,
      parallelism: 2,
      maxOutputTokens: 4096,
      synthesisThreshold: 0.8,
      synthesisFromRound: 8,
      stallRounds: 2,
    });
  });

  it('accepts partial overrides', () => {
    const config = RunConfigSchema.parse({ maxRounds: 3, parallelism: 1, maxCostUsd: 1 });
    expect(config.maxRounds).toBe(3);
    expect(config.parallelism).toBe(1);
    expect(config.maxCostUsd).toBe(1);
    expect(config.maxTokens).toBe(400_000);
  });

  it.each([
    ['zero rounds', { maxRounds: 0 }],
    ['zero parallelism', { parallelism: 0 }],
    ['negative cost', { maxCostUsd: -1 }],
    ['zero wall clock', { maxWallClockMs: 0 }],
    ['fractional wall clock', { maxWallClockMs: 1.5 }],
    ['zero output allowance', { maxOutputTokens: 0 }],
    ['threshold above 1', { synthesisThreshold: 1.2 }],
    ['fractional rounds', { maxRounds: 2.5 }],
  ])('rejects %s', (_label, input) => {
    expect(RunConfigSchema.safeParse(input).success).toBe(false);
  });
});
