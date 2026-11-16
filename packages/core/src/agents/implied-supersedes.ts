import type { BoardView } from '../board/board-view';
import type { Contribution } from '../schemas/contribution';
import { rejectedHypothesisIds } from './eligibility';

// A hypothesis that names the critiques it resolves is, by its own account, the answer to
// them, and a critique is answered only by a new version of the hypothesis it is against
// (docs/PLAN.md §2.1). Models set `resolves` reliably and `supersedes` not: in a rehearsal
// of 2026-11-16 the local Solver named critiques on 13 hypotheses that superseded nothing,
// so the critiques stayed open, it was sent back to them round after round and wrote the
// same answers again.
//
// So `supersedes` is read off `resolves` when a model leaves it out: when the critiques a
// hypothesis names are against one and the same standing hypothesis, the new hypothesis
// supersedes that one. This makes the model's own claim explicit; it is not a guess. With
// two standing targets, or none, or a target this reply already replaces, nothing is added
// and the critiques stay open.
export const withImpliedSupersedes = (
  view: BoardView,
  contributions: readonly Contribution[],
): readonly Contribution[] => {
  const rejected = rejectedHypothesisIds(view);
  // One new version per hypothesis: what the reply supersedes in so many words is taken.
  const taken = new Set(
    contributions.flatMap((c) =>
      c.type === 'hypothesis' && c.supersedes !== undefined ? [c.supersedes] : [],
    ),
  );
  return contributions.map((contribution) => {
    if (contribution.type !== 'hypothesis' || contribution.supersedes !== undefined) {
      return contribution;
    }
    const targets = new Set<string>();
    for (const id of contribution.payload.resolves ?? []) {
      const critique = view.byId(id);
      if (critique?.type !== 'critique') continue;
      const target = view.byId(critique.payload.target);
      if (target?.type === 'hypothesis' && view.isLive(target.id) && !rejected.has(target.id)) {
        targets.add(target.id);
      }
    }
    const [only] = targets;
    if (targets.size !== 1 || only === undefined || taken.has(only)) return contribution;
    taken.add(only);
    return { ...contribution, supersedes: only };
  });
};
