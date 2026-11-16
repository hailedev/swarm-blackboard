import type { BoardView } from '../board/board-view';
import { lineOf, standingHypotheses } from './eligibility';

// Contradictions between hypotheses, read off the board (docs/PLAN.md §2.3 step 7). Pure
// functions of the view, so the roles' triggers and prompts can use them as well as the
// controller, which keeps the one piece of memory the flow needs (controller/conflict.ts:
// which conflicts the Critic has already addressed).

export type Conflict = { a: string; b: string } & (
  | { via: 'contradictedBy' }
  | { via: 'evidence'; evidenceId: string }
  // Two answers to one subproblem, one of them posted as the other's rival. `line` names the
  // two lines of answers by their first versions, so the conflict stays the same conflict
  // when either side is replaced by a new version.
  | { via: 'rival'; line: string }
);

export const conflictKey = (conflict: Conflict): string =>
  conflict.via === 'rival' ? conflict.line : `${conflict.a}|${conflict.b}`;

/** The live entry at the end of the line that `id` belongs to, if the line is still alive. */
const headOf = (view: BoardView, id: string): string | undefined => {
  let current = view.byId(id);
  const seen = new Set<string>();
  while (current !== undefined && !seen.has(current.id)) {
    seen.add(current.id);
    const next = view.supersededBy(current.id);
    if (next === undefined) break;
    current = next;
  }
  return current !== undefined && view.isLive(current.id) ? current.id : undefined;
};

const rootOf = (view: BoardView, id: string): string => lineOf(view, id).at(-1)?.id ?? id;

// Two live hypotheses contradict when one lists the other in `contradictedBy`, when a live
// evidence entry supports one and contradicts the other, or when one was posted as a rival
// to the other's line and both still stand.
export const detectConflicts = (view: BoardView): Conflict[] => {
  const hypotheses = view.liveOfType('hypothesis');
  const liveIds = new Set(hypotheses.map((h) => h.id));
  const found = new Map<string, Conflict>();
  const pair = (x: string, y: string): [string, string] | undefined => {
    if (x === y || !liveIds.has(x) || !liveIds.has(y)) return undefined;
    return x < y ? [x, y] : [y, x];
  };
  const add = (conflict: Conflict): void => {
    const key = `${conflict.a}|${conflict.b}`;
    if (!found.has(key)) found.set(key, conflict);
  };
  for (const h of hypotheses) {
    for (const other of h.payload.contradictedBy) {
      const ends = pair(h.id, other);
      if (ends !== undefined) add({ a: ends[0], b: ends[1], via: 'contradictedBy' });
    }
  }
  for (const e of view.liveOfType('evidence')) {
    for (const s of e.payload.supports) {
      for (const c of e.payload.contradicts) {
        const ends = pair(s, c);
        if (ends !== undefined) add({ a: ends[0], b: ends[1], via: 'evidence', evidenceId: e.id });
      }
    }
  }
  // Declared rivals: a standing hypothesis whose line was posted as a rival of another
  // line, where that other line still stands too. A decision rejects one line, which then
  // no longer stands, and the conflict is gone.
  const standing = new Set(standingHypotheses(view).map((h) => h.id));
  for (const id of standing) {
    for (const version of lineOf(view, id)) {
      if (version.type !== 'hypothesis') continue;
      for (const rivalled of version.payload.rivalOf) {
        const other = headOf(view, rivalled);
        if (other === undefined || !standing.has(other)) continue;
        const ends = pair(id, other);
        if (ends === undefined) continue;
        const line = `rival:${[rootOf(view, id), rootOf(view, other)].sort().join('|')}`;
        add({ a: ends[0], b: ends[1], via: 'rival', line });
      }
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

/** The contradictions no decision has settled yet. */
export const openConflicts = (view: BoardView): Conflict[] =>
  detectConflicts(view).filter((conflict) => !isDecided(view, conflict));

/** The hypotheses on either side of an unsettled contradiction, each once, in commit order. */
export const contradictingHypothesisIds = (view: BoardView): string[] => {
  const ids = new Set(openConflicts(view).flatMap((conflict) => [conflict.a, conflict.b]));
  return view
    .liveOfType('hypothesis')
    .filter((h) => ids.has(h.id))
    .map((h) => h.id);
};
