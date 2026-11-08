import type { BoardView } from '../board/board-view';

export type Conflict = { a: string; b: string } & (
  { via: 'contradictedBy' } | { via: 'evidence'; evidenceId: string }
);

export const conflictKey = (conflict: Conflict): string => `${conflict.a}|${conflict.b}`;

// Two live hypotheses contradict when one lists the other in `contradictedBy`,
// or when a live evidence entry supports one and contradicts the other.
export const detectConflicts = (view: BoardView): Conflict[] => {
  const hypotheses = view.liveOfType('hypothesis');
  const liveIds = new Set(hypotheses.map((h) => h.id));
  const found = new Map<string, Conflict>();
  const add = (x: string, y: string, via: Conflict['via'], evidenceId?: string): void => {
    if (x === y || !liveIds.has(x) || !liveIds.has(y)) return;
    const [a, b] = x < y ? [x, y] : [y, x];
    const key = `${a}|${b}`;
    if (found.has(key)) return;
    found.set(
      key,
      via === 'evidence' && evidenceId !== undefined
        ? { a, b, via: 'evidence', evidenceId }
        : { a, b, via: 'contradictedBy' },
    );
  };
  for (const h of hypotheses) {
    for (const other of h.payload.contradictedBy) add(h.id, other, 'contradictedBy');
  }
  for (const e of view.liveOfType('evidence')) {
    for (const s of e.payload.supports) {
      for (const c of e.payload.contradicts) add(s, c, 'evidence', e.id);
    }
  }
  return [...found.values()];
};

/** A live decision that picks one side of the conflict and rejects the other. */
export const isDecided = (view: BoardView, conflict: Conflict): boolean =>
  view
    .liveOfType('decision')
    .some(
      (d) =>
        (d.payload.chosen === conflict.a && d.payload.rejected.includes(conflict.b)) ||
        (d.payload.chosen === conflict.b && d.payload.rejected.includes(conflict.a)),
    );

export interface ConflictAssessment {
  conflicts: readonly Conflict[];
  /** An undecided conflict the Critic has not yet addressed → Critic forced next round. */
  criticForced: boolean;
  /** An undecided conflict the Critic has addressed → a decision is required before synthesis. */
  decisionRequired: boolean;
}

// docs/PLAN.md §2.3 step 7. Remembers which conflicts the Critic has already
// critiqued so that a persisting conflict escalates to "decision required".
export class ConflictTracker {
  readonly #critiqued = new Set<string>();

  assess(view: BoardView, critiqueTargets: ReadonlySet<string>): ConflictAssessment {
    const conflicts = detectConflicts(view);
    for (const conflict of conflicts) {
      if (critiqueTargets.has(conflict.a) || critiqueTargets.has(conflict.b)) {
        this.#critiqued.add(conflictKey(conflict));
      }
    }
    const open = conflicts.filter((c) => !isDecided(view, c));
    return {
      conflicts,
      criticForced: open.some((c) => !this.#critiqued.has(conflictKey(c))),
      decisionRequired: open.some((c) => this.#critiqued.has(conflictKey(c))),
    };
  }
}
