import { z } from 'zod';

import { IdSchema, IsoDateSchema, RoundSchema, UsageSchema } from './common';
import { EntrySchema, ProblemEntrySchema } from './entry';
import { RunConfigSchema } from './run-config';

// The event log is the source of truth (ADR-0004). The board view is a fold over it.
const EventBaseSchema = z.object({
  id: IdSchema,
  runId: IdSchema,
  seq: z.int().nonnegative(),
  at: IsoDateSchema,
});

export const EligibilityRecordSchema = z.object({
  agentId: z.string().min(1),
  priority: z.number(),
  reason: z.string(),
});
export type EligibilityRecord = z.infer<typeof EligibilityRecordSchema>;

export const TerminationReasonSchema = z.enum([
  'synthesis_confident',
  'stalled',
  'budget:rounds',
  'budget:tokens',
  'budget:cost',
  'budget:wall_clock',
  'no_eligible_agents',
]);
export type TerminationReason = z.infer<typeof TerminationReasonSchema>;

export const AgentFailureReasonSchema = z.enum(['model_error', 'invalid_output', 'invalid_links']);
export type AgentFailureReason = z.infer<typeof AgentFailureReasonSchema>;

export const RunTotalsSchema = z.object({
  rounds: z.int().nonnegative(),
  entries: z.int().nonnegative(),
  usage: UsageSchema,
  elapsedMs: z.int().nonnegative(),
});
export type RunTotals = z.infer<typeof RunTotalsSchema>;

export const RunStartedEventSchema = EventBaseSchema.extend({
  type: z.literal('run_started'),
  problemEntry: ProblemEntrySchema,
  config: RunConfigSchema,
});
export const RoundStartedEventSchema = EventBaseSchema.extend({
  type: z.literal('round_started'),
  round: RoundSchema,
});
export const AgentsSelectedEventSchema = EventBaseSchema.extend({
  type: z.literal('agents_selected'),
  round: RoundSchema,
  selected: z.array(z.string().min(1)),
  eligible: z.array(EligibilityRecordSchema),
});
export const EntryCommittedEventSchema = EventBaseSchema.extend({
  type: z.literal('entry_committed'),
  round: RoundSchema,
  entry: EntrySchema,
});
export const AgentFailedEventSchema = EventBaseSchema.extend({
  type: z.literal('agent_failed'),
  round: RoundSchema,
  agentId: z.string().min(1),
  reason: AgentFailureReasonSchema,
  detail: z.string(),
});
export const RoundCompletedEventSchema = EventBaseSchema.extend({
  type: z.literal('round_completed'),
  round: RoundSchema,
  newEntries: z.int().nonnegative(),
  usage: UsageSchema,
});
export const RunTerminatedEventSchema = EventBaseSchema.extend({
  type: z.literal('run_terminated'),
  round: RoundSchema,
  reason: TerminationReasonSchema,
  totals: RunTotalsSchema,
});

export const BoardEventSchema = z.discriminatedUnion('type', [
  RunStartedEventSchema,
  RoundStartedEventSchema,
  AgentsSelectedEventSchema,
  EntryCommittedEventSchema,
  AgentFailedEventSchema,
  RoundCompletedEventSchema,
  RunTerminatedEventSchema,
]);

export type BoardEvent = z.infer<typeof BoardEventSchema>;
export type BoardEventType = BoardEvent['type'];
export type BoardEventOf<T extends BoardEventType> = Extract<BoardEvent, { type: T }>;
