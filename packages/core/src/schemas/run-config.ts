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

// The final write-up (docs/PLAN.md §2.3 step 8): when a run ends, the Synthesizer's model
// writes the answer once more from the whole live board. Its worst-case cost is held back
// from `maxCostUsd` from the first round on, so both figures bound that cost: the output
// allowance (the words asked for are `wordBudgetFor` of the allowance the call gets,
// agents/word-budget.ts) and the characters of board the prompt may hold.
export const WriteUpConfigSchema = z.object({
  /** Output allowance of the write-up call; 2,700 tokens ask for about 900 words. */
  maxOutputTokens: z.int().min(1).default(2_700),
  /**
   * Characters of board the write-up prompt may hold, after the problem and the human
   * notes, which are always shown in full. Entries past it are named in one line each.
   */
  maxBoardChars: z.int().min(1).default(48_000),
});
export type WriteUpConfig = z.output<typeof WriteUpConfigSchema>;

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
  // A log recorded before the write-up existed has no such key and reads as the defaults.
  writeUp: WriteUpConfigSchema.prefault({}),
});

export type RunConfig = z.output<typeof RunConfigSchema>;
export type RunConfigInput = z.input<typeof RunConfigSchema>;

export const defaultRunConfig = (): RunConfig => RunConfigSchema.parse({});
