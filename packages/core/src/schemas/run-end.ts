import { z } from 'zod';

// Why a run stopped. One enum shared by core, API and UI (docs/budget-guardrails.md §5).
// `no_eligible_agents` is not in the guardrails list but is a real stop condition from
// Phase 1, so it stays.
export const RunEndReasonSchema = z.enum([
  'completed',
  'budget_cost',
  'budget_rounds',
  'budget_tokens',
  'budget_time',
  'monthly_budget',
  'stalled',
  'no_eligible_agents',
  'billing',
  'auth',
  'rate_limit',
  'provider_unreachable',
  'user_stopped',
]);
export type RunEndReason = z.infer<typeof RunEndReasonSchema>;

// Reasons that pause a run rather than end it: the run can resume when the month rolls
// over, the limit is raised, or the provider comes back.
export const PauseReasonSchema = RunEndReasonSchema.extract([
  'monthly_budget',
  'rate_limit',
  'provider_unreachable',
]);
export type PauseReason = z.infer<typeof PauseReasonSchema>;

const PAUSE_REASONS: readonly RunEndReason[] = PauseReasonSchema.options;

export const isPauseReason = (reason: RunEndReason): reason is PauseReason =>
  PAUSE_REASONS.includes(reason);

export const TerminalReasonSchema = RunEndReasonSchema.exclude(PauseReasonSchema.options);
export type TerminalReason = z.infer<typeof TerminalReasonSchema>;

// Reasons the provider layer classifies as terminal for the whole run: retrying can only
// waste time, and falling back to another paid model would be the silent spend the
// guardrails exist to prevent.
export const FailureReasonSchema = RunEndReasonSchema.extract(['billing', 'auth']);
export type FailureReason = z.infer<typeof FailureReasonSchema>;

export const RunBudgetReasonSchema = RunEndReasonSchema.extract([
  'budget_cost',
  'budget_rounds',
  'budget_tokens',
  'budget_time',
]);
export type RunBudgetReason = z.infer<typeof RunBudgetReasonSchema>;

export const RunStatusSchema = z.enum(['completed', 'failed', 'paused', 'stopped']);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const TerminalStatusSchema = RunStatusSchema.exclude(['paused']);
export type TerminalStatus = z.infer<typeof TerminalStatusSchema>;

export const terminalStatusFor = (reason: TerminalReason): TerminalStatus => {
  switch (reason) {
    case 'billing':
    case 'auth':
      return 'failed';
    case 'user_stopped':
      return 'stopped';
    case 'completed':
    case 'budget_cost':
    case 'budget_rounds':
    case 'budget_tokens':
    case 'budget_time':
    case 'stalled':
    case 'no_eligible_agents':
      return 'completed';
  }
};

export const runStatusFor = (reason: RunEndReason): RunStatus =>
  isPauseReason(reason) ? 'paused' : terminalStatusFor(reason);

/** A run that has stopped, for now or for good. */
export const RunEndSchema = z.object({ status: RunStatusSchema, reason: RunEndReasonSchema });
export type RunEnd = z.infer<typeof RunEndSchema>;

export const runEnd = (reason: RunEndReason): RunEnd => ({ status: runStatusFor(reason), reason });
