import type { BoardEvent } from '@team/core';
import { BoardFixture } from '@team/core/testing';
import { describe, expect, it } from 'vitest';

import { describeOpenCritiques, loopFigures } from './loop';

const overLimit = (round: number): BoardEvent => ({
  id: `event-${String(round)}`,
  runId: 'run',
  seq: round,
  at: '2026-11-16T00:00:00.000Z',
  type: 'agent_failed',
  round,
  agentId: 'critic',
  reason: 'over_limit',
  detail: 'kept 6 of 8 contributions, the most severe first; 2 dropped',
});

describe('loopFigures', () => {
  it('sorts every critique into answered, gone unanswered, or still standing', () => {
    const fx = new BoardFixture();
    fx.problem();
    fx.startRound(1);
    const first = fx.entry('hypothesis', { confidence: 0.5, supportedBy: [], contradictedBy: [] });
    const named = fx.entry('critique', { target: first.id, severity: 'blocking' });
    // Its target is replaced below, but the new version does not name it.
    fx.entry('critique', { target: first.id, severity: 'major' });
    fx.startRound(2);
    const second = fx.entry(
      'hypothesis',
      { confidence: 0.7, supportedBy: [], contradictedBy: [], resolves: [named.id] },
      { supersedes: first.id },
    );
    fx.entry('critique', { target: second.id, severity: 'major' });
    fx.entry('critique', { target: second.id, severity: 'minor' });
    const other = fx.entry('hypothesis', { confidence: 0.4, supportedBy: [], contradictedBy: [] });
    // Against a hypothesis a decision rejects: nobody has to answer it any more.
    fx.entry('critique', { target: other.id, severity: 'blocking' });
    fx.entry('decision', { chosen: second.id, rejected: [other.id], rationale: 'Better backed.' });

    const figures = loopFigures(fx.view(), [], []);
    expect(figures.critiques).toEqual({
      raised: 5,
      resolved: 1,
      replaced: 2,
      open: { blocking: 0, major: 1, minor: 1 },
    });
    expect(figures.decisions).toBe(1);
    expect(figures.rejectedHypotheses).toBe(1);
    expect(describeOpenCritiques(figures.critiques.open)).toBe('1 major, 1 minor');
  });

  it('counts a critique that carries its own resolution as resolved', () => {
    const fx = new BoardFixture();
    fx.problem();
    fx.startRound(1);
    const hypothesis = fx.entry('hypothesis', {
      confidence: 0.5,
      supportedBy: [],
      contradictedBy: [],
    });
    const evidence = fx.entry('evidence', { source: 'a test', supports: [], contradicts: [] });
    fx.entry('critique', { target: hypothesis.id, severity: 'major', resolvedBy: evidence.id });
    const figures = loopFigures(fx.view(), [], []);
    expect(figures.critiques.resolved).toBe(1);
    expect(describeOpenCritiques(figures.critiques.open)).toBe('none');
  });

  it('reads subproblems off the board and counts drafts, rejected calls and trimmed replies', () => {
    const fx = new BoardFixture();
    fx.problem();
    fx.startRound(1);
    const answered = fx.entry('subproblem', { status: 'open' });
    const contested = fx.entry('subproblem', { status: 'open' });
    fx.entry('subproblem', { status: 'open' });
    fx.startRound(2);
    fx.entry(
      'hypothesis',
      { confidence: 0.6, supportedBy: [], contradictedBy: [] },
      { parents: [answered.id] },
    );
    const weak = fx.entry(
      'hypothesis',
      { confidence: 0.6, supportedBy: [], contradictedBy: [] },
      { parents: [contested.id] },
    );
    fx.entry('critique', { target: weak.id, severity: 'blocking' });
    fx.entry('synthesis', { version: 1, confidence: 0.5, cites: [], stage: 'draft' });
    fx.entry('synthesis', { version: 2, confidence: 0.6, cites: [], stage: 'final' });

    const figures = loopFigures(
      fx.view(),
      [overLimit(2), overLimit(3)],
      [{ outcome: 'ok' }, { outcome: 'invalid_output' }, { outcome: 'ok' }, { outcome: 'network' }],
    );
    expect(figures.subproblems).toEqual({ done: 1, claimed: 1, open: 1 });
    expect(figures.drafts).toBe(1);
    expect(figures.calls).toEqual({ made: 4, rejected: 1 });
    expect(figures.trimmedReplies).toBe(2);
    expect(figures.critiques.open).toEqual({ blocking: 1, major: 0, minor: 0 });
  });
});
