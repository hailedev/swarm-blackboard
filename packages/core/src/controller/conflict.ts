import { conflictKey, detectConflicts, isDecided, type Conflict } from '../agents/conflicts';
import type { BoardView } from '../board/board-view';

// Detection is pure and lives with the agents' predicates (agents/conflicts.ts), where the
// roles' triggers can read it too; it is re-exported here for the controller's callers.
export { conflictKey, detectConflicts, isDecided, type Conflict };

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
