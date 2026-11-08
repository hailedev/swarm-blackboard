import { z } from 'zod';

// Ids are UUID v7 strings (time-ordered, Postgres-portable).
export const IdSchema = z.uuidv7();

export const IsoDateSchema = z.iso.datetime();

export const RoundSchema = z.int().nonnegative();

export const UsageSchema = z.object({
  inputTokens: z.int().nonnegative(),
  outputTokens: z.int().nonnegative(),
  costUsd: z.number().nonnegative(),
});
export type Usage = z.infer<typeof UsageSchema>;

export const zeroUsage = (): Usage => ({ inputTokens: 0, outputTokens: 0, costUsd: 0 });

export const addUsage = (a: Usage, b: Usage): Usage => ({
  inputTokens: a.inputTokens + b.inputTokens,
  outputTokens: a.outputTokens + b.outputTokens,
  costUsd: a.costUsd + b.costUsd,
});

// Board-level status of an entry. Liveness (superseded or not) is derived, not stored.
export const EntryStatusSchema = z.enum(['active', 'pinned', 'dismissed']);
export type EntryStatus = z.infer<typeof EntryStatusSchema>;

// An agent id, or the literal "human" for user interventions.
export const HUMAN_AUTHOR = 'human';
export const AuthorSchema = z.string().min(1);

export const ConfidenceSchema = z.number().min(0).max(1);
