import { describe, expect, it } from 'vitest';

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
