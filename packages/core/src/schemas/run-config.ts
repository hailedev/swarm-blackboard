import { z } from 'zod';

import { ConfidenceSchema } from './common';

// Hard limits and controller knobs. Budgets are enforced in the controller, in code
// (CLAUDE.md architecture rule 4). Defaults are docs/PLAN.md §2.3.
export const RunConfigSchema = z.object({
  maxRounds: z.int().min(1).default(12),
  maxCostUsd: z.number().nonnegative().default(2.0),
  maxWallClockMin: z.number().positive().default(15),
  maxTotalTokens: z.int().min(1).default(400_000),
  parallelism: z.int().min(1).default(2),
  synthesisThreshold: ConfidenceSchema.default(0.8),
  // Round from which the Synthesizer is eligible regardless of board state ("round ≥ N").
  synthesisFromRound: z.int().min(1).default(8),
  // Consecutive rounds without a new entry that count as a stall.
  stallRounds: z.int().min(1).default(2),
});

export type RunConfig = z.output<typeof RunConfigSchema>;
export type RunConfigInput = z.input<typeof RunConfigSchema>;

export const defaultRunConfig = (): RunConfig => RunConfigSchema.parse({});
