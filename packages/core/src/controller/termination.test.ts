import { describe, expect, it } from 'vitest';

import { RunConfigSchema } from '../schemas/run-config';
import { BoardFixture } from '../testing/board-fixture';
import { checkTermination, synthesisReady } from './termination';

const config = RunConfigSchema.parse({});
const base = {
  config,
  budget: null,
  starved: false,
  stalled: false,
  eligibleCount: 3,
  decisionRequired: false,
} as const;

describe('checkTermination', () => {
  it('continues while nothing holds', () => {
    const fx = new BoardFixture();
    fx.problem();
    expect(checkTermination({ ...base, view: fx.view() })).toBeNull();
  });

  it('completes on a confident synthesis with no open blocking critique', () => {
    const fx = new BoardFixture();
    fx.problem();
    fx.startRound(1);
    const h = fx.entry('hypothesis', { confidence: 0.9, supportedBy: [], contradictedBy: [] });
    fx.entry('synthesis', { version: 1, confidence: 0.8, cites: [h.id] });
    expect(checkTermination({ ...base, view: fx.view() })).toBe('completed');
  });

  it('does not stop on a synthesis below the threshold or while a blocking critique is open', () => {
    const fx = new BoardFixture();
    fx.problem();
    fx.startRound(1);
    const h = fx.entry('hypothesis', { confidence: 0.9, supportedBy: [], contradictedBy: [] });
    fx.entry('synthesis', { version: 1, confidence: 0.79, cites: [h.id] });
    expect(checkTermination({ ...base, view: fx.view() })).toBeNull();
    fx.entry('synthesis', { version: 2, confidence: 0.95, cites: [h.id] });
    fx.entry('critique', { target: h.id, severity: 'blocking' });
    expect(checkTermination({ ...base, view: fx.view() })).toBeNull();
    expect(checkTermination({ ...base, view: fx.view(), budget: 'budget_cost' })).toBe(
      'budget_cost',
    );
  });

  it('reports budgets, starvation, stalls and empty eligibility in order', () => {
    const fx = new BoardFixture();
    fx.problem();
    const view = fx.view();
    expect(
      checkTermination({
        ...base,
        view,
        budget: 'budget_rounds',
        starved: true,
        stalled: true,
        eligibleCount: 0,
      }),
    ).toBe('budget_rounds');
    expect(checkTermination({ ...base, view, budget: 'budget_tokens' })).toBe('budget_tokens');
    expect(checkTermination({ ...base, view, budget: 'budget_time' })).toBe('budget_time');
    expect(checkTermination({ ...base, view, starved: true, stalled: true })).toBe('budget_cost');
    expect(checkTermination({ ...base, view, stalled: true, eligibleCount: 0 })).toBe('stalled');
    expect(checkTermination({ ...base, view, eligibleCount: 0 })).toBe('no_eligible_agents');
  });

  it('holds a confident synthesis back while a contradiction is undecided', () => {
    const fx = new BoardFixture();
    fx.problem();
    fx.startRound(1);
    const h = fx.entry('hypothesis', { confidence: 0.9, supportedBy: [], contradictedBy: [] });
    fx.entry('synthesis', { version: 1, confidence: 0.95, cites: [h.id] });
    const view = fx.view();
    expect(synthesisReady(view, config)).toBe(true);
    expect(checkTermination({ ...base, view, decisionRequired: true })).toBeNull();
    // The run then ends on whatever else holds, never on `completed`.
    expect(
      checkTermination({ ...base, view, decisionRequired: true, budget: 'budget_rounds' }),
    ).toBe('budget_rounds');
    expect(checkTermination({ ...base, view, decisionRequired: true, stalled: true })).toBe(
      'stalled',
    );
    expect(checkTermination({ ...base, view, decisionRequired: false })).toBe('completed');
  });

  it('a confident synthesis wins over an exhausted budget', () => {
    const fx = new BoardFixture();
    fx.problem();
    fx.startRound(1);
    fx.entry('synthesis', { version: 1, confidence: 0.99, cites: [] });
    expect(checkTermination({ ...base, view: fx.view(), budget: 'budget_rounds' })).toBe(
      'completed',
    );
  });
});
