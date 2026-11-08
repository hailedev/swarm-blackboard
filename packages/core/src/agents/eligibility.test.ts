import { describe, expect, it } from 'vitest';

import { BoardFixture } from '../testing/board-fixture';
import {
  boardIsNew,
  evidenceWithoutHypothesis,
  hypothesesLackingEvidence,
  hypothesesWithNewEvidence,
  hypothesesWithoutCritique,
  latestSynthesis,
  openSubproblems,
  synthesisCandidates,
} from './eligibility';

const hypothesisPayload = { confidence: 0.5, supportedBy: [], contradictedBy: [] };

describe('eligibility predicates', () => {
  it('boardIsNew holds with only the problem and human notes', () => {
    const fx = new BoardFixture();
    expect(boardIsNew(fx.view())).toBe(true);
    fx.problem();
    fx.entry('human_note', { priority: 'high' }, { author: 'human' });
    expect(boardIsNew(fx.view())).toBe(true);
    fx.startRound(1);
    fx.entry('subproblem', { status: 'open' });
    expect(boardIsNew(fx.view())).toBe(false);
  });

  it('openSubproblems ignores claimed, done and superseded ones', () => {
    const fx = new BoardFixture();
    fx.problem();
    fx.startRound(1);
    const open = fx.entry('subproblem', { status: 'open' });
    fx.entry('subproblem', { status: 'claimed' });
    const wasOpen = fx.entry('subproblem', { status: 'open' });
    fx.entry('subproblem', { status: 'done' }, { supersedes: wasOpen.id });
    expect(openSubproblems(fx.view()).map((s) => s.id)).toEqual([open.id]);
  });

  it('hypothesesLackingEvidence and evidenceWithoutHypothesis look at both link directions', () => {
    const fx = new BoardFixture();
    fx.problem();
    fx.startRound(1);
    const bare = fx.entry('hypothesis', hypothesisPayload);
    const e1 = fx.entry('evidence', { source: 's', supports: [], contradicts: [] });
    const linkedFromHypothesis = fx.entry('hypothesis', {
      ...hypothesisPayload,
      supportedBy: [e1.id],
    });
    const linkedFromEvidence = fx.entry('hypothesis', hypothesisPayload);
    fx.entry('evidence', { source: 's', supports: [], contradicts: [linkedFromEvidence.id] });
    const orphan = fx.entry('evidence', { source: 's', supports: [], contradicts: [] });
    const view = fx.view();
    expect(hypothesesLackingEvidence(view).map((h) => h.id)).toEqual([bare.id]);
    expect(evidenceWithoutHypothesis(view).map((e) => e.id)).toEqual([orphan.id]);
    expect(linkedFromHypothesis.payload.supportedBy).toEqual([e1.id]);
  });

  it('hypothesesWithoutCritique and hypothesesWithNewEvidence', () => {
    const fx = new BoardFixture();
    fx.problem();
    fx.startRound(1);
    const critiqued = fx.entry('hypothesis', hypothesisPayload);
    const fresh = fx.entry('hypothesis', hypothesisPayload);
    fx.entry('critique', { target: critiqued.id, severity: 'minor' });
    fx.startRound(3);
    fx.entry('evidence', { source: 's', supports: [critiqued.id], contradicts: [] });
    const view = fx.view();
    expect(hypothesesWithoutCritique(view).map((h) => h.id)).toEqual([fresh.id]);
    expect(hypothesesWithNewEvidence(view, 3).map((h) => h.id)).toEqual([critiqued.id]);
    expect(hypothesesWithNewEvidence(view, 4)).toEqual([]);
  });

  it('synthesisCandidates excludes hypotheses under an open blocking critique', () => {
    const fx = new BoardFixture();
    fx.problem();
    fx.startRound(1);
    const blocked = fx.entry('hypothesis', hypothesisPayload);
    const minorOnly = fx.entry('hypothesis', hypothesisPayload);
    const resolved = fx.entry('hypothesis', hypothesisPayload);
    fx.entry('critique', { target: blocked.id, severity: 'blocking' });
    fx.entry('critique', { target: minorOnly.id, severity: 'major' });
    fx.entry('critique', { target: resolved.id, severity: 'blocking', resolvedBy: minorOnly.id });
    expect(synthesisCandidates(fx.view()).map((h) => h.id)).toEqual([minorOnly.id, resolved.id]);
  });

  it('latestSynthesis picks the highest live version', () => {
    const fx = new BoardFixture();
    fx.problem();
    expect(latestSynthesis(fx.view())).toBeUndefined();
    fx.startRound(1);
    fx.entry('synthesis', { version: 1, confidence: 0.5, cites: [] });
    const v3 = fx.entry('synthesis', { version: 3, confidence: 0.7, cites: [] });
    fx.entry('synthesis', { version: 2, confidence: 0.9, cites: [] });
    expect(latestSynthesis(fx.view())?.id).toBe(v3.id);
  });
});
