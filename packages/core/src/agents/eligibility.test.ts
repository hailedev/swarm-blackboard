import { describe, expect, it } from 'vitest';

import { BoardFixture } from '../testing/board-fixture';
import {
  boardIsNew,
  evidenceWithoutHypothesis,
  hypothesesLackingEvidence,
  hypothesesWithNewEvidence,
  hypothesesWithoutCritique,
  latestSynthesis,
  openCritiquesOf,
  openSubproblems,
  rejectedHypothesisIds,
  standingHypotheses,
  subproblemStatus,
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

describe('subproblemStatus: where a subproblem stands, read off the board', () => {
  const board = () => {
    const fx = new BoardFixture();
    const problem = fx.problem();
    fx.startRound(1);
    const answered = fx.entry('subproblem', { status: 'open' }, { parents: [problem.id] });
    const untouched = fx.entry('subproblem', { status: 'open' }, { parents: [problem.id] });
    return { fx, problem, answered, untouched };
  };
  const statuses = (fx: BoardFixture) => {
    const view = fx.view();
    return view.liveOfType('subproblem').map((s) => subproblemStatus(view, s));
  };

  it('is open until a hypothesis names it as a parent, then done', () => {
    const { fx, answered, untouched } = board();
    expect(statuses(fx)).toEqual(['open', 'open']);
    fx.entry('hypothesis', hypothesisPayload, { parents: [answered.id] });
    expect(statuses(fx)).toEqual(['done', 'open']);
    expect(openSubproblems(fx.view()).map((s) => s.id)).toEqual([untouched.id]);
  });

  it('is claimed while a blocking or major critique stands against its answer, done again once it is replaced', () => {
    const { fx, answered } = board();
    const first = fx.entry('hypothesis', hypothesisPayload, { parents: [answered.id] });
    const minor = fx.entry('critique', { target: first.id, severity: 'minor' });
    expect(statuses(fx)[0]).toBe('done');
    const major = fx.entry('critique', { target: first.id, severity: 'major' });
    expect(statuses(fx)[0]).toBe('claimed');
    // Answered, though contested: not open, so nobody is sent to answer it from scratch.
    expect(openSubproblems(fx.view()).map((s) => s.id)).not.toContain(answered.id);
    expect(openCritiquesOf(fx.view(), first.id).map((c) => c.id)).toEqual([major.id]);
    expect(openCritiquesOf(fx.view(), first.id, ['minor']).map((c) => c.id)).toEqual([minor.id]);

    // The Solver's new version drops the subproblem from its parents; it still answers it,
    // because the version it replaced did.
    fx.entry(
      'hypothesis',
      { ...hypothesisPayload, resolves: [major.id] },
      { parents: [], supersedes: first.id },
    );
    expect(statuses(fx)[0]).toBe('done');
  });

  it('follows a subproblem the Planner restated', () => {
    const { fx, answered } = board();
    fx.entry('hypothesis', hypothesisPayload, { parents: [answered.id] });
    const restated = fx.entry('subproblem', { status: 'open' }, { supersedes: answered.id });
    const view = fx.view();
    expect(subproblemStatus(view, restated)).toBe('done');
  });

  it('is done when one of two answers is uncontested, and open again when its only answer is rejected', () => {
    const { fx, answered } = board();
    const weak = fx.entry('hypothesis', hypothesisPayload, { parents: [answered.id] });
    fx.entry('critique', { target: weak.id, severity: 'blocking' });
    const sound = fx.entry('hypothesis', hypothesisPayload, { parents: [answered.id] });
    expect(statuses(fx)[0]).toBe('done');

    const rejecting = board();
    const only = rejecting.fx.entry('hypothesis', hypothesisPayload, {
      parents: [rejecting.answered.id],
    });
    const other = rejecting.fx.entry('hypothesis', hypothesisPayload);
    expect(statuses(rejecting.fx)[0]).toBe('done');
    rejecting.fx.entry('decision', { chosen: other.id, rejected: [only.id], rationale: 'r' });
    expect(statuses(rejecting.fx)[0]).toBe('open');
    expect([...rejectedHypothesisIds(rejecting.fx.view())]).toEqual([only.id]);
    expect(standingHypotheses(rejecting.fx.view()).map((h) => h.id)).toEqual([other.id]);
    expect(sound.id).not.toBe(weak.id);
  });

  it('keeps what an older log recorded when no hypothesis answers the subproblem', () => {
    const fx = new BoardFixture();
    fx.problem();
    fx.startRound(1);
    const claimed = fx.entry('subproblem', { status: 'claimed' });
    const done = fx.entry('subproblem', { status: 'done' });
    const view = fx.view();
    expect(subproblemStatus(view, claimed)).toBe('claimed');
    expect(subproblemStatus(view, done)).toBe('done');
  });
});
