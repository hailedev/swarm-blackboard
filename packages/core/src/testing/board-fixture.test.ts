import { describe, expect, it } from 'vitest';

import { BoardFixture } from './board-fixture';

describe('BoardFixture', () => {
  it('produces schema-valid entries and events with contiguous seq', () => {
    const fx = new BoardFixture();
    const problem = fx.problem('P');
    fx.startRound(1);
    const sub = fx.entry('subproblem', { status: 'claimed' }, { author: 'planner', content: 'S' });
    expect(problem.author).toBe('human');
    expect(problem.content).toBe('P');
    expect(sub.round).toBe(1);
    expect(sub.author).toBe('planner');
    expect(fx.events.map((e) => e.seq)).toEqual([0, 1, 2]);
    expect(fx.events.map((e) => e.type)).toEqual([
      'entry_committed',
      'round_started',
      'entry_committed',
    ]);
  });

  it('rejects an invalid payload instead of committing it', () => {
    const fx = new BoardFixture();
    expect(() =>
      fx.entry('hypothesis', { confidence: 2, supportedBy: [], contradictedBy: [] }),
    ).toThrow();
    expect(fx.events).toEqual([]);
  });
});
