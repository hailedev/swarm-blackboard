import { describe, expect, it } from 'vitest';

import {
  isPauseReason,
  runEnd,
  RunEndReasonSchema,
  runStatusFor,
  terminalStatusFor,
} from './run-end';

describe('run end reasons', () => {
  it('maps every reason to a status', () => {
    const statuses = Object.fromEntries(
      RunEndReasonSchema.options.map((reason) => [reason, runStatusFor(reason)]),
    );
    expect(statuses).toEqual({
      completed: 'completed',
      budget_cost: 'completed',
      budget_rounds: 'completed',
      budget_tokens: 'completed',
      budget_time: 'completed',
      stalled: 'completed',
      no_eligible_agents: 'completed',
      monthly_budget: 'paused',
      rate_limit: 'paused',
      provider_unreachable: 'paused',
      billing: 'failed',
      auth: 'failed',
      user_stopped: 'stopped',
    });
  });

  it('tells pauses from terminal ends', () => {
    expect(isPauseReason('rate_limit')).toBe(true);
    expect(isPauseReason('billing')).toBe(false);
    expect(terminalStatusFor('user_stopped')).toBe('stopped');
    expect(runEnd('monthly_budget')).toEqual({ status: 'paused', reason: 'monthly_budget' });
    expect(runEnd('auth')).toEqual({ status: 'failed', reason: 'auth' });
    expect(runEnd('stalled')).toEqual({ status: 'completed', reason: 'stalled' });
  });
});
