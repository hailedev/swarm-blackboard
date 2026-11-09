import { z } from 'zod';

import { ConfidenceSchema } from './common';

// Size bounds of the view an agent receives (docs/PLAN.md §2.2, "Agent board view").
// Measured in characters: the token estimate in reservation.ts is derived from them.
export const ViewBoundsSchema = z.object({
  /** Entries shown in full: the trigger's targets, their neighbours and role extras. */
  maxFocusEntries: z.int().min(1).default(20),
  /** Content characters across all focus entries. */
  maxFocusChars: z.int().min(1).default(12_000),
  /** Content characters per entry before it is clipped. */
  maxEntryChars: z.int().min(1).default(1_000),
  /** Characters for the one-line digests of everything else. */
  maxSummaryChars: z.int().min(1).default(4_000),
});
export type ViewBounds = z.output<typeof ViewBoundsSchema>;

// Hard limits and controller knobs. Budgets are enforced in the controller, in code
// (CLAUDE.md architecture rule 4). Defaults are docs/budget-guardrails.md §2 and §6.
export const RunConfigSchema = z.object({
  maxRounds: z.int().min(1).default(12),
  maxCostUsd: z.number().nonnegative().default(0.25),
  // All roles, prompt and completion, including cache reads and writes.
  maxTokens: z.int().min(1).default(400_000),
  maxWallClockMs: z
    .int()
    .positive()
    .default(15 * 60_000),
  parallelism: z.int().min(1).default(2),
  // Output allowance per model call before the reservation logic shrinks it.
  maxOutputTokens: z.int().min(1).default(4096),
  synthesisThreshold: ConfidenceSchema.default(0.8),
  // Round from which the Synthesizer is eligible regardless of board state ("round ≥ N").
  synthesisFromRound: z.int().min(1).default(8),
  // Consecutive rounds without a new entry that count as a stall.
  stallRounds: z.int().min(1).default(2),
  // Zod 4's .default() returns its value unparsed; .prefault() fills the nested defaults.
  view: ViewBoundsSchema.prefault({}),
});

export type RunConfig = z.output<typeof RunConfigSchema>;
export type RunConfigInput = z.input<typeof RunConfigSchema>;

export const defaultRunConfig = (): RunConfig => RunConfigSchema.parse({});
