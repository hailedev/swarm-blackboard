import { describe, expect, it } from 'vitest';

import { zeroUsage } from '../schemas/common';
import { BoardFixture } from '../testing/board-fixture';
import { buildBoardView } from './board-view';

describe('buildBoardView', () => {
  it('is empty for an empty log', () => {
    const view = buildBoardView('run', []);
    expect(view.entries).toEqual([]);
    expect(view.live).toEqual([]);
    expect(view.round).toBe(0);
    expect(view.lastEntryRound).toBeNull();
    expect(view.problem()).toBeUndefined();
    expect(view.byId('nope')).toBeUndefined();
    expect(view.isLive('nope')).toBe(false);
    expect(view.chain('nope')).toEqual([]);
    expect(view.childrenOf('nope')).toEqual([]);
    expect(view.handleOf('nope')).toBeUndefined();
    expect(view.byHandle('H1')).toBeUndefined();
  });

  it('assigns handles per type in commit order, stable under supersede and dismiss', () => {
    const fx = new BoardFixture();
    const problem = fx.problem();
    fx.startRound(1);
    const h1 = fx.entry('hypothesis', { confidence: 0.5, supportedBy: [], contradictedBy: [] });
    const e1 = fx.entry('evidence', { source: 'a', supports: [h1.id], contradicts: [] });
    const h2 = fx.entry('hypothesis', { confidence: 0.6, supportedBy: [], contradictedBy: [] });
    fx.startRound(2);
    // Supersede H1 and dismiss H2: both keep their handles, the newcomers get the next ones.
    const h3 = fx.entry(
      'hypothesis',
      { confidence: 0.8, supportedBy: [e1.id], contradictedBy: [] },
      { supersedes: h1.id },
    );
    const h4 = fx.entry(
      'hypothesis',
      { confidence: 0.6, supportedBy: [], contradictedBy: [] },
      { supersedes: h2.id, status: 'dismissed' },
    );
    const note = fx.entry('human_note', { priority: 'high' }, { author: 'human' });
    const synthesis = fx.entry('synthesis', { version: 1, confidence: 0.7, cites: [h3.id] });

    const view = fx.view();
    const handles = [problem, h1, e1, h2, h3, h4, note, synthesis].map((e) => view.handleOf(e.id));
    expect(handles).toEqual(['P1', 'H1', 'E1', 'H2', 'H3', 'H4', 'N1', 'A1']);
    for (const entry of view.entries) {
      const handle = view.handleOf(entry.id);
      expect(handle).toBeDefined();
      if (handle !== undefined) expect(view.byHandle(handle)?.id).toBe(entry.id);
    }
    expect(view.isLive(h1.id)).toBe(false);
    expect(view.handleOf(h1.id)).toBe('H1');
    expect(view.byHandle('H9')).toBeUndefined();
  });

  it('keeps every committed entry in order and tracks rounds', () => {
    const fx = new BoardFixture();
    const problem = fx.problem();
    fx.startRound(1);
    const sub = fx.entry('subproblem', { status: 'open' }, { parents: [problem.id] });
    fx.startRound(2);
    const before = JSON.stringify(fx.events);

    const view = fx.view();
    expect(view.entries.map((e) => e.id)).toEqual([problem.id, sub.id]);
    expect(view.round).toBe(2);
    expect(view.lastEntryRound).toBe(1);
    expect(view.problem()?.id).toBe(problem.id);
    expect(view.byId(sub.id)?.type).toBe('subproblem');
    expect(view.childrenOf(problem.id).map((e) => e.id)).toEqual([sub.id]);
    expect(JSON.stringify(fx.events)).toBe(before);
  });

  it('derives liveness from supersede links and dismissal', () => {
    const fx = new BoardFixture();
    const problem = fx.problem();
    fx.startRound(1);
    const h1 = fx.entry('hypothesis', { confidence: 0.5, supportedBy: [], contradictedBy: [] });
    fx.startRound(2);
    const h2 = fx.entry(
      'hypothesis',
      { confidence: 0.8, supportedBy: [], contradictedBy: [] },
      { supersedes: h1.id },
    );
    const q = fx.entry('question', {});
    const qDismissed = fx.entry('question', {}, { supersedes: q.id, status: 'dismissed' });

    const view = fx.view();
    expect(view.isLive(problem.id)).toBe(true);
    expect(view.isLive(h1.id)).toBe(false);
    expect(view.isLive(h2.id)).toBe(true);
    expect(view.isLive(q.id)).toBe(false);
    expect(view.isLive(qDismissed.id)).toBe(false);
    expect(view.live.map((e) => e.id)).toEqual([problem.id, h2.id]);
    expect(view.liveOfType('hypothesis').map((e) => e.payload.confidence)).toEqual([0.8]);
    expect(view.supersededBy(h1.id)?.id).toBe(h2.id);
    expect(view.supersededBy(h2.id)).toBeUndefined();
    expect(view.chain(h1.id).map((e) => e.id)).toEqual([h1.id, h2.id]);
    expect(view.chain(h2.id).map((e) => e.id)).toEqual([h1.id, h2.id]);
  });

  it('links evidence to hypotheses from either side', () => {
    const fx = new BoardFixture();
    fx.problem();
    fx.startRound(1);
    const e1 = fx.entry('evidence', { source: 'a', supports: [], contradicts: [] });
    const h = fx.entry('hypothesis', {
      confidence: 0.6,
      supportedBy: [e1.id],
      contradictedBy: [],
    });
    const e2 = fx.entry('evidence', { source: 'b', supports: [h.id], contradicts: [] });
    const e3 = fx.entry('evidence', { source: 'c', supports: [], contradicts: [h.id] });
    fx.entry(
      'evidence',
      { source: 'd', supports: [], contradicts: [h.id] },
      { status: 'dismissed' },
    );

    const view = fx.view();
    expect(view.evidenceSupporting(h.id).map((e) => e.id)).toEqual([e1.id, e2.id]);
    expect(view.evidenceContradicting(h.id).map((e) => e.id)).toEqual([e3.id]);
    expect(view.evidenceSupporting(e1.id)).toEqual([]);
  });

  it('reports open blocking critiques only while unresolved and targeting a live entry', () => {
    const fx = new BoardFixture();
    fx.problem();
    fx.startRound(1);
    const h1 = fx.entry('hypothesis', { confidence: 0.5, supportedBy: [], contradictedBy: [] });
    const h2 = fx.entry('hypothesis', { confidence: 0.5, supportedBy: [], contradictedBy: [] });
    const h3 = fx.entry('hypothesis', { confidence: 0.5, supportedBy: [], contradictedBy: [] });
    const blocking = fx.entry('critique', { target: h1.id, severity: 'blocking' });
    const major = fx.entry('critique', { target: h1.id, severity: 'major' });
    const onH2 = fx.entry('critique', { target: h2.id, severity: 'blocking' });
    const onH3 = fx.entry('critique', { target: h3.id, severity: 'blocking' });

    expect(
      fx
        .view()
        .openBlockingCritiques()
        .map((c) => c.id),
    ).toEqual([blocking.id, onH2.id, onH3.id]);
    expect(
      fx
        .view()
        .critiquesOf(h1.id)
        .map((c) => c.id),
    ).toEqual([blocking.id, major.id]);

    fx.startRound(2);
    // Resolve one by a superseding critique with resolvedBy, one by superseding its target.
    const fix = fx.entry('hypothesis', { confidence: 0.9, supportedBy: [], contradictedBy: [] });
    fx.entry(
      'critique',
      { target: h1.id, severity: 'blocking', resolvedBy: fix.id },
      { supersedes: blocking.id },
    );
    fx.entry(
      'hypothesis',
      { confidence: 0.7, supportedBy: [], contradictedBy: [] },
      { supersedes: h2.id },
    );

    const view = fx.view();
    expect(view.openBlockingCritiques().map((c) => c.id)).toEqual([onH3.id]);
    expect(view.critiquesOf(h1.id).map((c) => c.payload.resolvedBy)).toEqual([undefined, fix.id]);
  });
});

describe('callsOf: what the log says an agent was called on', () => {
  it('lists a call once its round has completed, with the targets it was pointed at', () => {
    const fx = new BoardFixture();
    fx.problem();
    fx.startRound(1);
    const hypothesis = fx.entry('hypothesis', {
      confidence: 0.5,
      supportedBy: [],
      contradictedBy: [],
    });
    fx.completeRound({ solver: [] });
    expect(fx.view().callsOf('critic')).toEqual([]);
    fx.startRound(2);
    // Selected and not yet returned: nothing to say about it.
    fx.completeRound({ critic: [hypothesis.id], researcher: [hypothesis.id] });
    const view = fx.view();
    expect(view.callsOf('critic')).toEqual([{ round: 2, targetIds: [hypothesis.id] }]);
    expect(view.callsOf('researcher')).toEqual([{ round: 2, targetIds: [hypothesis.id] }]);
    expect(view.callsOf('solver')).toEqual([{ round: 1, targetIds: [] }]);
    expect(view.callsOf('planner')).toEqual([]);
  });

  it('leaves out a call that failed, and keeps one whose output was only cut or partly kept', () => {
    const fx = new BoardFixture();
    fx.problem();
    fx.startRound(1);
    fx.failedCall('critic', ['x']);
    expect(fx.view().callsOf('critic')).toEqual([]);
    fx.startRound(2);
    const at = fx.events.length;
    fx.completeRound({ critic: ['y'] });
    // An over-limit note between the selection and the end of the round: the call returned.
    fx.events.splice(at + 1, 0, {
      id: fx.ids.next(),
      runId: fx.runId,
      seq: at + 1,
      at: '2026-11-17T00:00:00.000Z',
      type: 'agent_failed',
      round: 2,
      agentId: 'critic',
      reason: 'over_limit',
      detail: 'kept 6 of 8 contributions, the most severe first; 2 dropped',
    });
    expect(fx.view().callsOf('critic')).toEqual([{ round: 2, targetIds: ['y'] }]);
  });

  it('knows nothing of a round the host did not live to finish, or of a log with no targets', () => {
    const fx = new BoardFixture();
    fx.problem();
    fx.startRound(1);
    fx.events.push({
      id: fx.ids.next(),
      runId: fx.runId,
      seq: fx.events.length,
      at: '2026-11-17T00:00:00.000Z',
      type: 'agents_selected',
      round: 1,
      selected: ['critic'],
      eligible: [{ agentId: 'critic', priority: 80, reason: 'r', targetIds: ['x'] }],
    });
    fx.events.push({
      id: fx.ids.next(),
      runId: fx.runId,
      seq: fx.events.length,
      at: '2026-11-17T00:00:00.000Z',
      type: 'round_abandoned',
      round: 1,
      newEntries: 0,
      usage: zeroUsage(),
    });
    expect(fx.view().callsOf('critic')).toEqual([]);
  });
});
