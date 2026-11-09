import { describe, expect, it } from 'vitest';

import { eligible, mandatory, notEligible } from '../agents/agent';
import { selectAgents, type Candidate } from './selection';

const c = (agentId: string, priority: number | null): Candidate => ({
  agentId,
  trigger: priority === null ? notEligible('no') : eligible(priority, [], 'yes'),
});

describe('selectAgents', () => {
  it('takes the top-k eligible agents by priority', () => {
    const picked = selectAgents(
      [c('planner', null), c('researcher', 60), c('solver', 70), c('critic', 80)],
      2,
      [],
    );
    expect(picked).toEqual(['critic', 'solver']);
  });

  it('breaks ties by roster order', () => {
    expect(selectAgents([c('a', 50), c('b', 50), c('c', 50)], 2, [])).toEqual(['a', 'b']);
  });

  it('returns nothing when nobody is eligible', () => {
    expect(selectAgents([c('a', null)], 2, [])).toEqual([]);
  });

  it('skips an agent selected in both of the previous two rounds', () => {
    const candidates = [c('solver', 70), c('researcher', 60)];
    expect(selectAgents(candidates, 1, [['solver']])).toEqual(['solver']);
    expect(selectAgents(candidates, 1, [['solver'], ['solver']])).toEqual(['researcher']);
    expect(selectAgents(candidates, 1, [['solver'], ['researcher'], ['solver']])).toEqual([
      'solver',
    ]);
  });

  it('does not back-fill with blocked agents, but uses them when nobody else is eligible', () => {
    const history = [
      ['solver', 'critic'],
      ['solver', 'critic'],
    ];
    expect(
      selectAgents([c('solver', 70), c('critic', 80), c('researcher', 60)], 2, history),
    ).toEqual(['researcher']);
    expect(selectAgents([c('solver', 70), c('critic', 80)], 2, history)).toEqual([
      'critic',
      'solver',
    ]);
  });

  it('selects a mandatory agent first, whatever the priorities and the diversity rule say', () => {
    const forced: Candidate = { agentId: 'synthesizer', trigger: mandatory([], 'forced') };
    // Ahead of an equal priority earlier in the roster, and of a higher one.
    expect(selectAgents([c('planner', 100), forced], 1, [])).toEqual(['synthesizer']);
    expect(selectAgents([c('critic', 500), forced, c('solver', 70)], 2, [])).toEqual([
      'synthesizer',
      'critic',
    ]);
    // Selected in both previous rounds: anyone else would sit this one out.
    const history = [['synthesizer'], ['synthesizer']];
    expect(selectAgents([c('solver', 70), forced], 1, history)).toEqual(['synthesizer']);
    expect(
      selectAgents(
        [c('solver', 70), { agentId: 'synthesizer', trigger: eligible(95, [], 'late') }],
        1,
        history,
      ),
    ).toEqual(['solver']);
  });
});
