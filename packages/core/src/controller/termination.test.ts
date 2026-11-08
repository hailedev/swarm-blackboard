import { describe, expect, it } from 'vitest';

import { RunConfigSchema } from '../schemas/run-config';
import { BoardFixture } from '../testing/board-fixture';
import { checkTermination } from './termination';

const config = RunConfigSchema.parse({});
const base = { config, budget: null, stalled: false, eligibleCount: 3 } as const;

describe('checkTermination', () => {
  it('continues while nothing holds', () => {
    const fx = new BoardFixture();
    fx.problem();
    expect(checkTermination({ ...base, view: fx.view() })).toBeNull();
  });

  it('stops on a confident synthesis with no open blocking critique', () => {
    const fx = new BoardFixture();
    fx.problem();
    fx.startRound(1);
    const h = fx.entry('hypothesis', { confidence: 0.9, supportedBy: [], contradictedBy: [] });
    fx.entry('synthesis', { version: 1, confidence: 0.8, cites: [h.id] });
    expect(checkTermination({ ...base, view: fx.view() })).toBe('synthesis_confident');
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
    expect(checkTermination({ ...base, view: fx.view(), budget: 'cost' })).toBe('budget:cost');
  });

  it('reports budgets, stalls and empty eligibility in order', () => {
    const fx = new BoardFixture();
    fx.problem();
    const view = fx.view();
    expect(
      checkTermination({ ...base, view, budget: 'rounds', stalled: true, eligibleCount: 0 }),
    ).toBe('budget:rounds');
    expect(checkTermination({ ...base, view, budget: 'tokens' })).toBe('budget:tokens');
    expect(checkTermination({ ...base, view, budget: 'wall_clock' })).toBe('budget:wall_clock');
    expect(checkTermination({ ...base, view, stalled: true, eligibleCount: 0 })).toBe('stalled');
    expect(checkTermination({ ...base, view, eligibleCount: 0 })).toBe('no_eligible_agents');
  });

  it('a confident synthesis wins over an exhausted budget', () => {
    const fx = new BoardFixture();
    fx.problem();
    fx.startRound(1);
    fx.entry('synthesis', { version: 1, confidence: 0.99, cites: [] });
    expect(checkTermination({ ...base, view: fx.view(), budget: 'rounds' })).toBe(
      'synthesis_confident',
    );
  });
});
