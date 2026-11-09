import { describe, expect, it } from 'vitest';

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
