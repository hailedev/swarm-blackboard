import { describe, expect, it } from 'vitest';

import { agentContext } from '../testing/agent-context';
import { BoardFixture } from '../testing/board-fixture';
import { renderAgentPrompt } from './prompt';

describe('renderAgentPrompt', () => {
  it('describes the problem, every live entry and the active flags', () => {
    const fx = new BoardFixture();
    fx.problem('Pick a database');
    fx.startRound(1);
    const old = fx.entry('hypothesis', { confidence: 0.4, supportedBy: [], contradictedBy: [] });
    const fresh = fx.entry(
      'hypothesis',
      { confidence: 0.8, supportedBy: [], contradictedBy: [] },
      { supersedes: old.id, content: 'Use SQLite' },
    );
    fx.entry('critique', { target: fresh.id, severity: 'major' }, { content: 'No benchmarks' });
    fx.entry('question', {}, { content: 'Budget?' });
    fx.entry('evidence', { source: 'docs', supports: [fresh.id], contradicts: [] });
    fx.entry('subproblem', { status: 'claimed' });
    fx.entry('decision', { chosen: fresh.id, rejected: [old.id], rationale: 'r' });
    fx.entry('synthesis', { version: 1, confidence: 0.6, cites: [fresh.id] });
    fx.entry('human_note', { priority: 'high' }, { author: 'human', content: 'Hurry' });

    const { system, prompt } = renderAgentPrompt(
      'critic',
      fx.view(),
      agentContext({ round: 2, flags: { criticForced: true } }),
    );
    expect(system).toContain('critic agent');
    expect(prompt).toContain('Round 2 of 12');
    expect(prompt).toContain('# Problem\nPick a database');
    expect(prompt).toContain('Use SQLite');
    expect(prompt).not.toContain(`[hypothesis] ${old.id}`);
    expect(prompt).toContain('severity=major');
    expect(prompt).toContain('Budget?');
    expect(prompt).toContain('source=docs');
    expect(prompt).toContain('status=claimed');
    expect(prompt).toContain('chosen=');
    expect(prompt).toContain('version=1');
    expect(prompt).toContain('priority=high');
    expect(prompt).toContain('Control flags: criticForced');
  });

  it('renders constraints, criteria and an empty board', () => {
    const fx = new BoardFixture();
    fx.entry(
      'problem',
      { constraints: ['Under $100'], successCriteria: ['Cited answer'] },
      { author: 'human', content: 'P' },
    );
    const { prompt } = renderAgentPrompt('planner', fx.view(), agentContext());
    expect(prompt).toContain('Constraints:\n- Under $100');
    expect(prompt).toContain('Success criteria:\n- Cited answer');
    expect(prompt).toContain('# Live board\n(empty)');
    expect(prompt).not.toContain('Control flags');
  });

  it('copes with a board that has no problem entry', () => {
    const { prompt } = renderAgentPrompt('solver', new BoardFixture().view(), agentContext());
    expect(prompt).toContain('# Live board\n(empty)');
    expect(prompt).not.toContain('# Problem');
  });
});
