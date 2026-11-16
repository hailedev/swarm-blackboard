import { describe, expect, it } from 'vitest';

import { isDeclaredRival, rejectedHypothesisIds, standingAnswers } from '../agents/eligibility';
import { BoardFixture } from '../testing/board-fixture';
import { ConflictTracker, conflictKey, detectConflicts, isDecided } from './conflict';

const hyp = (contradictedBy: string[] = []) => ({
  confidence: 0.5,
  supportedBy: [],
  contradictedBy,
});

describe('detectConflicts', () => {
  it('finds contradictions declared on a hypothesis and via evidence, once per pair', () => {
    const fx = new BoardFixture();
    fx.problem();
    fx.startRound(1);
    const h1 = fx.entry('hypothesis', hyp());
    const h2 = fx.entry('hypothesis', hyp([h1.id]));
    const h3 = fx.entry('hypothesis', hyp());
    const e = fx.entry('evidence', { source: 's', supports: [h1.id], contradicts: [h3.id, h1.id] });
    fx.entry('evidence', { source: 's', supports: [h2.id], contradicts: [h1.id] });

    const conflicts = detectConflicts(fx.view());
    expect(conflicts.map(conflictKey).sort()).toEqual(
      [[h1.id, h2.id].sort().join('|'), [h1.id, h3.id].sort().join('|')].sort(),
    );
    const viaEvidence = conflicts.find((c) => c.via === 'evidence');
    expect(viaEvidence?.via === 'evidence' && viaEvidence.evidenceId).toBe(e.id);
  });

  it('ignores superseded hypotheses and dangling references', () => {
    const fx = new BoardFixture();
    fx.problem();
    fx.startRound(1);
    const h1 = fx.entry('hypothesis', hyp());
    fx.entry('hypothesis', hyp([h1.id]));
    fx.entry('hypothesis', hyp(), { supersedes: h1.id });
    fx.entry('hypothesis', hyp(['00000000-0000-7000-8000-00000000ffff']));
    expect(detectConflicts(fx.view())).toEqual([]);
  });
});

describe('ConflictTracker', () => {
  it('forces the critic first, then requires a decision, then clears when decided', () => {
    const fx = new BoardFixture();
    fx.problem();
    fx.startRound(1);
    const h1 = fx.entry('hypothesis', hyp());
    const h2 = fx.entry('hypothesis', hyp([h1.id]));
    const tracker = new ConflictTracker();

    const fresh = tracker.assess(fx.view(), new Set());
    expect(fresh.conflicts.length).toBe(1);
    expect(fresh.criticForced).toBe(true);
    expect(fresh.decisionRequired).toBe(false);

    const critiqued = tracker.assess(fx.view(), new Set([h1.id]));
    expect(critiqued.criticForced).toBe(false);
    expect(critiqued.decisionRequired).toBe(true);

    const later = tracker.assess(fx.view(), new Set());
    expect(later.decisionRequired).toBe(true);

    fx.startRound(2);
    fx.entry('decision', { chosen: h2.id, rejected: [h1.id], rationale: 'Stronger evidence.' });
    const decided = tracker.assess(fx.view(), new Set());
    expect(decided.conflicts.length).toBe(1);
    expect(decided.criticForced).toBe(false);
    expect(decided.decisionRequired).toBe(false);
    expect(
      isDecided(fx.view(), decided.conflicts[0] ?? { a: '', b: '', via: 'contradictedBy' }),
    ).toBe(true);
  });

  it('a decision that does not reject the other side does not settle the conflict', () => {
    const fx = new BoardFixture();
    fx.problem();
    fx.startRound(1);
    const h1 = fx.entry('hypothesis', hyp());
    const h2 = fx.entry('hypothesis', hyp([h1.id]));
    fx.entry('decision', { chosen: h2.id, rejected: [], rationale: 'r' });
    const [conflict] = detectConflicts(fx.view());
    expect(conflict !== undefined && isDecided(fx.view(), conflict)).toBe(false);
  });
});

describe('isDecided, either way round', () => {
  it('accepts a decision that chooses the later hypothesis and rejects the earlier one', () => {
    const fx = new BoardFixture();
    fx.problem();
    fx.startRound(1);
    const h1 = fx.entry('hypothesis', hyp());
    const h2 = fx.entry('hypothesis', hyp([h1.id]));
    fx.entry('decision', { chosen: h2.id, rejected: [h1.id], rationale: 'r' });
    const [conflict] = detectConflicts(fx.view());
    expect(conflict).toEqual({ a: h1.id, b: h2.id, via: 'contradictedBy' });
    expect(conflict !== undefined && isDecided(fx.view(), conflict)).toBe(true);
  });
});

describe('declared rivals', () => {
  // One subproblem, its answer, and a second hypothesis posted as that answer's rival.
  const rivals = () => {
    const fx = new BoardFixture();
    fx.problem();
    fx.startRound(1);
    const subproblem = fx.entry('subproblem', { status: 'open' });
    fx.startRound(2);
    const first = fx.entry('hypothesis', hyp(), { parents: [subproblem.id] });
    fx.startRound(3);
    const rival = fx.entry(
      'hypothesis',
      { ...hyp(), rivalOf: [first.id] },
      { parents: [subproblem.id] },
    );
    return { fx, subproblem, first, rival };
  };

  it('are a conflict while both stand', () => {
    const { fx, subproblem, first, rival } = rivals();
    const [conflict] = detectConflicts(fx.view());
    expect(conflict).toMatchObject({ a: first.id, b: rival.id, via: 'rival' });
    expect(standingAnswers(fx.view(), subproblem)).toHaveLength(2);
    expect(isDeclaredRival(fx.view(), rival.id)).toBe(true);
    expect(isDeclaredRival(fx.view(), first.id)).toBe(false);
  });

  it('stay the same conflict when either side is replaced by a new version', () => {
    const { fx, first, rival } = rivals();
    const before = detectConflicts(fx.view()).map(conflictKey);
    fx.startRound(4);
    const firstAgain = fx.entry('hypothesis', hyp(), { supersedes: first.id });
    const rivalAgain = fx.entry('hypothesis', hyp(), { supersedes: rival.id });
    const [conflict] = detectConflicts(fx.view());
    // The pair is the two new versions; the key is the two lines.
    expect([conflict?.a, conflict?.b].sort()).toEqual([firstAgain.id, rivalAgain.id].sort());
    expect(detectConflicts(fx.view()).map(conflictKey)).toEqual(before);
    expect(isDeclaredRival(fx.view(), rivalAgain.id)).toBe(true);

    // So the Critic is not forced again for a conflict it has already addressed.
    const tracker = new ConflictTracker();
    const { fx: fresh, first: a } = rivals();
    expect(tracker.assess(fresh.view(), new Set([a.id]))).toMatchObject({
      criticForced: false,
      decisionRequired: true,
    });
    fresh.startRound(4);
    fresh.entry('hypothesis', hyp(), { supersedes: a.id });
    expect(tracker.assess(fresh.view(), new Set())).toMatchObject({
      criticForced: false,
      decisionRequired: true,
    });
  });

  it('are settled by a decision, which takes the rejected line and its later versions out', () => {
    const { fx, subproblem, first, rival } = rivals();
    fx.startRound(4);
    // The Solver posts a new version of the rival in the round the decision rejects it.
    const rivalAgain = fx.entry('hypothesis', hyp(), { supersedes: rival.id });
    fx.entry('decision', { chosen: first.id, rejected: [rival.id], rationale: 'Better backed.' });
    const view = fx.view();
    expect([...rejectedHypothesisIds(view)].sort()).toEqual([rival.id, rivalAgain.id].sort());
    expect(standingAnswers(view, subproblem).map((h) => h.id)).toEqual([first.id]);
    expect(detectConflicts(view)).toEqual([]);
    expect(new ConflictTracker().assess(view, new Set())).toMatchObject({
      criticForced: false,
      decisionRequired: false,
    });
  });

  it('are no conflict once the rivalled answer is gone', () => {
    const { fx, subproblem, first, rival } = rivals();
    fx.startRound(4);
    fx.entry('decision', { chosen: rival.id, rejected: [first.id], rationale: 'Better backed.' });
    expect(detectConflicts(fx.view())).toEqual([]);
    expect(standingAnswers(fx.view(), subproblem).map((h) => h.id)).toEqual([rival.id]);
  });
});
