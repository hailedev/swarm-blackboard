import type { BoardView } from '../board/board-view';
import type { Contribution } from '../schemas/contribution';
import type { EntryOf } from '../schemas/entry';
import { rejectedHypothesisIds, standingAnswers } from './eligibility';

// What a new hypothesis replaces, read off what the model did say when it does not say it.
//
// A subproblem takes one answer (docs/PLAN.md §2.1): a hypothesis posted where one already
// stands either replaces it or is declared its rival. Models set `resolves` and `parents`
// reliably and `supersedes` not: in the rehearsals of 2026-11-16 the local Solver named
// critiques on 13 hypotheses of one run that superseded nothing, and wrote a second full
// set of hypotheses beside the first in two runs of three. The standing hypotheses were
// never replaced, their critiques stayed open, and it was sent back to write the same
// answers again.

const liveSubproblems = (view: BoardView, ids: readonly string[]): EntryOf<'subproblem'>[] =>
  ids.flatMap((id) => {
    const entry = view.byId(id);
    return entry?.type === 'subproblem' && view.isLive(entry.id) ? [entry] : [];
  });

/**
 * `supersedes` for a hypothesis that leaves it out and is not a declared rival:
 *
 * 1. when the critiques it names are against one and the same standing hypothesis, that one;
 * 2. otherwise, when the subproblems it answers have exactly one standing answer between
 *    them, that one.
 *
 * This makes the model's own claim explicit; it is not a guess. With two candidates, none,
 * or one the same reply already replaces, nothing is added.
 */
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
    if (
      contribution.type !== 'hypothesis' ||
      contribution.supersedes !== undefined ||
      (contribution.payload.rivalOf ?? []).length > 0
    ) {
      return contribution;
    }
    const critiqued = new Set<string>();
    for (const id of contribution.payload.resolves ?? []) {
      const critique = view.byId(id);
      if (critique?.type !== 'critique') continue;
      const target = view.byId(critique.payload.target);
      if (target?.type === 'hypothesis' && view.isLive(target.id) && !rejected.has(target.id)) {
        critiqued.add(target.id);
      }
    }
    const answered = new Set(
      liveSubproblems(view, contribution.parents).flatMap((subproblem) =>
        standingAnswers(view, subproblem).map((hypothesis) => hypothesis.id),
      ),
    );
    const candidates = critiqued.size > 0 ? critiqued : answered;
    const [only] = candidates;
    if (candidates.size !== 1 || only === undefined || taken.has(only)) return contribution;
    taken.add(only);
    return { ...contribution, supersedes: only };
  });
};

export interface SettledAnswers {
  contributions: readonly Contribution[];
  /** Hypotheses left out because their subproblem already had its answer for this reply. */
  dropped: number;
}

/**
 * One answer per subproblem, enforced on a whole reply. After `withImpliedSupersedes`, each
 * hypothesis is checked against what stands for the subproblems it names, as the reply's
 * earlier hypotheses have left it:
 *
 * - a subproblem with no answer takes it;
 * - a subproblem whose answer it replaces takes it in that answer's place;
 * - a subproblem it was declared a rival on takes it beside the others;
 * - any other subproblem is struck from its parents: it would be an undeclared second answer.
 *
 * A hypothesis left with none of the subproblems it named, and replacing nothing, is
 * dropped, as is a second new version of a hypothesis the reply has already replaced.
 * Hypotheses that name no subproblem, and other contributions, pass through.
 */
export const settleAnswers = (
  view: BoardView,
  contributions: readonly Contribution[],
): SettledAnswers => {
  const standing = new Map<string, string[]>();
  const standingOf = (subproblem: EntryOf<'subproblem'>): string[] => {
    const known = standing.get(subproblem.id);
    if (known !== undefined) return known;
    const fresh = standingAnswers(view, subproblem).map((hypothesis) => hypothesis.id);
    standing.set(subproblem.id, fresh);
    return fresh;
  };
  // A hypothesis of this reply stands under a token until it has an id; `origin` remembers
  // which board entry it took the place of, so a rival declared on that entry still counts.
  const origin = new Map<string, string>();
  const replaced = new Set<string>();
  const kept: Contribution[] = [];
  let dropped = 0;

  withImpliedSupersedes(view, contributions).forEach((contribution, index) => {
    if (contribution.type !== 'hypothesis') {
      kept.push(contribution);
      return;
    }
    const { supersedes } = contribution;
    if (supersedes !== undefined) {
      if (replaced.has(supersedes)) {
        dropped += 1;
        return;
      }
      replaced.add(supersedes);
    }
    const subproblems = liveSubproblems(view, contribution.parents);
    if (subproblems.length === 0) {
      kept.push(contribution);
      return;
    }
    const rivalOf = contribution.payload.rivalOf ?? [];
    const takes = subproblems.filter((subproblem) => {
      const now = standingOf(subproblem);
      if (now.length === 0) return true;
      if (supersedes !== undefined && now.includes(supersedes)) return true;
      return rivalOf.length > 0 && now.every((id) => rivalOf.includes(origin.get(id) ?? id));
    });
    if (takes.length === 0 && supersedes === undefined) {
      dropped += 1;
      return;
    }
    const token = `reply:${String(index)}`;
    if (supersedes !== undefined) origin.set(token, supersedes);
    for (const subproblem of takes) {
      const now = standingOf(subproblem);
      const at = supersedes === undefined ? -1 : now.indexOf(supersedes);
      if (at >= 0) now[at] = token;
      else now.push(token);
    }
    const named = new Set(subproblems.map((subproblem) => subproblem.id));
    const taking = new Set(takes.map((subproblem) => subproblem.id));
    kept.push({
      ...contribution,
      parents: contribution.parents.filter((id) => !named.has(id) || taking.has(id)),
    });
  });
  return { contributions: kept, dropped };
};
