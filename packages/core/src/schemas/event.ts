import { z } from 'zod';

import { IdSchema, IsoDateSchema, RoundSchema, UsageSchema } from './common';
import { EntrySchema, ProblemEntrySchema } from './entry';
import { RunProfileSchema } from './roster';
import { RunConfigSchema } from './run-config';
import { PauseReasonSchema, RunEndReasonSchema, RunStatusSchema } from './run-end';

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

// Why an agent produced nothing usable this round. Model-call failures carry the
// provider error kind (docs/budget-guardrails.md §4) so the UI can show what happened.
export const AgentFailureReasonSchema = z.enum([
  'invalid_output',
  'invalid_links',
  'budget_exhausted',
  'billing',
  'auth',
  'rate_limit',
  'overloaded',
  'invalid_request',
  'network',
  'script_exhausted',
  'exception',
]);
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
  /** Budget snapshot for the run. */
  config: RunConfigSchema,
  /** Profile and resolved models, or null when the host did not use agents.yaml. */
  profile: RunProfileSchema.nullable(),
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
// A round the host left in flight when it died, recorded at recovery just before the
// `run_paused` that marks the run interrupted. The round counts as used, with whatever its
// agents committed before the process stopped, and the resumed run continues at the next
// number: every round has exactly one `round_started`.
export const RoundAbandonedEventSchema = EventBaseSchema.extend({
  type: z.literal('round_abandoned'),
  round: RoundSchema,
  newEntries: z.int().nonnegative(),
  usage: UsageSchema,
});
// The user asked for a synthesis now (docs/PLAN.md §2.3, human-in-the-loop). The first
// round that starts after this event runs the Synthesizer whatever its trigger says; the
// request is on the log so a paused or restarted run still honours it (ADR-0011).
export const SynthesisRequestedEventSchema = EventBaseSchema.extend({
  type: z.literal('synthesis_requested'),
  round: RoundSchema,
});
// Emitted once per run when month-to-date spend crosses the warning fraction.
export const BudgetWarningEventSchema = EventBaseSchema.extend({
  type: z.literal('budget_warning'),
  round: RoundSchema,
  spentUsd: z.number().nonnegative(),
  limitUsd: z.number().nonnegative(),
});
// A graceful, resumable stop.
export const RunPausedEventSchema = EventBaseSchema.extend({
  type: z.literal('run_paused'),
  round: RoundSchema,
  reason: PauseReasonSchema,
  totals: RunTotalsSchema,
});
// The run picks up again after a pause; `from` is the reason it had paused for.
export const RunResumedEventSchema = EventBaseSchema.extend({
  type: z.literal('run_resumed'),
  round: RoundSchema,
  from: PauseReasonSchema,
});
export const RunTerminatedEventSchema = EventBaseSchema.extend({
  type: z.literal('run_terminated'),
  round: RoundSchema,
  status: RunStatusSchema.exclude(['paused']),
  reason: RunEndReasonSchema.exclude(PauseReasonSchema.options),
  totals: RunTotalsSchema,
});

export const BoardEventSchema = z.discriminatedUnion('type', [
  RunStartedEventSchema,
  RoundStartedEventSchema,
  AgentsSelectedEventSchema,
  EntryCommittedEventSchema,
  AgentFailedEventSchema,
  RoundCompletedEventSchema,
  RoundAbandonedEventSchema,
  SynthesisRequestedEventSchema,
  BudgetWarningEventSchema,
  RunPausedEventSchema,
  RunResumedEventSchema,
  RunTerminatedEventSchema,
]);

export type BoardEvent = z.infer<typeof BoardEventSchema>;
export type BoardEventType = BoardEvent['type'];
export type BoardEventOf<T extends BoardEventType> = Extract<BoardEvent, { type: T }>;
