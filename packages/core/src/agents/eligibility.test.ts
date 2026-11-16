import { describe, expect, it } from 'vitest';

import { BoardFixture } from '../testing/board-fixture';
import {
  boardIsNew,
  evidenceWithoutHypothesis,
  hypothesesLackingEvidence,
  hypothesesToReview,
  hypothesesWithNewEvidence,
  hypothesesWithoutCritique,
  latestSynthesis,
  openContestingCritiques,
  openCritiquesOf,
  openSubproblems,
  rejectedHypothesisIds,
  standingHypotheses,
  subproblemStatus,
  synthesisCandidates,
  synthesisIsCurrent,
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

describe('what the Critic has left to review, and whether a synthesis is current', () => {
  it('owes a review to every standing version no Critic call was pointed at', () => {
    const fx = new BoardFixture();
    fx.problem();
    fx.startRound(1);
    const first = fx.entry('hypothesis', hypothesisPayload);
    const second = fx.entry('hypothesis', hypothesisPayload);
    fx.completeRound({ solver: [] });
    expect(hypothesesToReview(fx.view()).map((h) => h.id)).toEqual([first.id, second.id]);
    fx.startRound(2);
    fx.completeRound({ critic: [first.id] });
    expect(hypothesesToReview(fx.view()).map((h) => h.id)).toEqual([second.id]);
    // A new version is a new thing to review; the version it replaced is not.
    fx.startRound(3);
    const again = fx.entry('hypothesis', hypothesisPayload, { supersedes: first.id });
    fx.completeRound({ solver: [first.id] });
    expect(hypothesesToReview(fx.view()).map((h) => h.id)).toEqual([second.id, again.id]);
    // Nor is a hypothesis a decision rejected.
    fx.entry('decision', { chosen: again.id, rejected: [second.id], rationale: 'r' });
    expect(hypothesesToReview(fx.view()).map((h) => h.id)).toEqual([again.id]);
  });

  it('owes another review when evidence lands in or after the round of the last one', () => {
    const fx = new BoardFixture();
    fx.problem();
    fx.startRound(1);
    const hypothesis = fx.entry('hypothesis', hypothesisPayload);
    fx.entry('evidence', { source: 'before', supports: [hypothesis.id], contradicts: [] });
    fx.completeRound({ solver: [] });
    fx.startRound(2);
    fx.completeRound({ critic: [hypothesis.id] });
    // The evidence of round 1 was there to be read: nothing is owed.
    expect(hypothesesToReview(fx.view())).toEqual([]);
    // Posted in the round of the review, beside it: the Critic has not read this.
    fx.entry('evidence', { source: 'beside', supports: [], contradicts: [hypothesis.id] });
    expect(hypothesesToReview(fx.view()).map((h) => h.id)).toEqual([hypothesis.id]);
  });

  it('calls a synthesis current only when it was written after the last hypothesis and critique', () => {
    const fx = new BoardFixture();
    fx.problem();
    expect(synthesisIsCurrent(fx.view())).toBe(false);
    fx.startRound(1);
    const hypothesis = fx.entry('hypothesis', hypothesisPayload);
    fx.entry('synthesis', { version: 1, confidence: 0.9, cites: [hypothesis.id] });
    // Same round: written beside the hypothesis, not after it.
    expect(synthesisIsCurrent(fx.view())).toBe(false);
    fx.startRound(2);
    fx.entry('synthesis', { version: 2, confidence: 0.9, cites: [hypothesis.id] });
    expect(synthesisIsCurrent(fx.view())).toBe(true);
    // Evidence and questions do not make it stale; a critique does, of any severity.
    fx.entry('evidence', { source: 's', supports: [hypothesis.id], contradicts: [] });
    fx.entry('question', {});
    expect(synthesisIsCurrent(fx.view())).toBe(true);
    fx.entry('critique', { target: hypothesis.id, severity: 'minor' });
    expect(synthesisIsCurrent(fx.view())).toBe(false);
  });

  it('takes the later of two live syntheses with one version number as the latest', () => {
    const fx = new BoardFixture();
    fx.problem();
    fx.startRound(1);
    fx.entry('synthesis', { version: 1, confidence: 0.4, cites: [] });
    fx.startRound(2);
    const later = fx.entry('synthesis', { version: 1, confidence: 0.9, cites: [] });
    expect(latestSynthesis(fx.view())?.id).toBe(later.id);
  });

  it('counts blocking and major critiques that stand as what a run may not end with', () => {
    const fx = new BoardFixture();
    fx.problem();
    fx.startRound(1);
    const standing = fx.entry('hypothesis', hypothesisPayload);
    const replaced = fx.entry('hypothesis', hypothesisPayload);
    const blocking = fx.entry('critique', { target: standing.id, severity: 'blocking' });
    const major = fx.entry('critique', { target: standing.id, severity: 'major' });
    fx.entry('critique', { target: standing.id, severity: 'minor' });
    fx.entry('critique', { target: replaced.id, severity: 'major' });
    fx.entry('hypothesis', hypothesisPayload, { supersedes: replaced.id });
    expect(openContestingCritiques(fx.view()).map((c) => c.id)).toEqual([blocking.id, major.id]);
  });
});
