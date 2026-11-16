import type { BoardView } from '../board/board-view';

// Contradictions between hypotheses, read off the board (docs/PLAN.md §2.3 step 7). Pure
// functions of the view, so the roles' triggers and prompts can use them as well as the
// controller, which keeps the one piece of memory the flow needs (controller/conflict.ts:
// which conflicts the Critic has already addressed).

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
