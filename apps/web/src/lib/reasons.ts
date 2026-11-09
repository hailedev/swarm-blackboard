import type { AgentFailureReason, RunEndReason } from '@team/core';
import type { RunRecordStatus } from '@team/server/api';

// Why a run is not running, in words. The reason enum is shared by core, the API and the
// UI (docs/budget-guardrails.md §5); the records below are exhaustive by type, so a reason
// added to core does not compile here until it has a label.

export interface ReasonText {
  /** A few words that read on after the status: "Paused — at your request". */
  label: string;
  /** One sentence saying what happened and, where it applies, what to do about it. */
  detail: string;
}

export const REASON_TEXT: Record<RunEndReason, ReasonText> = {
  completed: {
    label: 'answer reached',
    detail: 'A synthesis cleared the confidence threshold with no blocking critique open.',
  },
  budget_cost: {
    label: 'cost cap reached',
    detail: 'The run spent its per-run cost cap, or no further call would fit under it.',
  },
  budget_rounds: {
    label: 'round limit reached',
    detail: 'The run used all the rounds it was given.',
  },
  budget_tokens: {
    label: 'token limit reached',
    detail: 'The run used its token budget.',
  },
  budget_time: {
    label: 'time limit reached',
    detail: 'The run used its wall-clock budget.',
  },
  monthly_budget: {
    label: 'monthly budget spent',
    detail:
      'The month’s API budget is used up. Resume next month, or after raising MONTHLY_BUDGET_USD.',
  },
  stalled: {
    label: 'stalled',
    detail: 'No new entries for several rounds, even after the Planner reframed the problem.',
  },
  no_eligible_agents: {
    label: 'nothing left to do',
    detail: 'No agent was eligible to act on the board as it stood.',
  },
  billing: {
    label: 'billing error',
    detail:
      'The provider refused a call for billing reasons: check the credit balance and the Console spend limit.',
  },
  auth: {
    label: 'API key rejected',
    detail: 'The provider rejected the API key. Check ANTHROPIC_API_KEY.',
  },
  rate_limit: {
    label: 'rate limited',
    detail: 'The provider kept rate-limiting or was overloaded. Resume to try again.',
  },
  provider_unreachable: {
    label: 'model unreachable',
    detail: 'A model could not be reached (is Ollama awake?). Resume to try again.',
  },
  user_paused: {
    label: 'at your request',
    detail: 'You paused the run. Resume to continue from where it stopped.',
  },
  interrupted: {
    label: 'interrupted by a server restart',
    detail: 'The server stopped while this run was in flight. Resume to continue from its log.',
  },
  user_stopped: {
    label: 'at your request',
    detail: 'You stopped the run.',
  },
};

export const STATUS_LABEL: Record<RunRecordStatus, string> = {
  running: 'Running',
  paused: 'Paused',
  completed: 'Completed',
  failed: 'Failed',
  stopped: 'Stopped',
};

export const FAILURE_LABEL: Record<AgentFailureReason, string> = {
  invalid_output: 'invalid output',
  invalid_links: 'invalid links',
  budget_exhausted: 'no budget left for the call',
  billing: 'billing error',
  auth: 'API key rejected',
  rate_limit: 'rate limited',
  overloaded: 'provider overloaded',
  invalid_request: 'request refused',
  network: 'model unreachable',
  script_exhausted: 'script exhausted',
  exception: 'agent crashed',
};
