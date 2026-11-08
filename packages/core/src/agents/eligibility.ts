import type { BoardView } from '../board/board-view';
import type { EntryOf } from '../schemas/entry';

// Pure predicates over the board, one per rule in docs/PLAN.md §2.2.

/** Nothing but the problem (and human notes) has been posted yet. */
export const boardIsNew = (view: BoardView): boolean =>
  view.live.every((entry) => entry.type === 'problem' || entry.type === 'human_note');

export const openSubproblems = (view: BoardView): readonly EntryOf<'subproblem'>[] =>
  view.liveOfType('subproblem').filter((s) => s.payload.status === 'open');

export const hypothesesLackingEvidence = (view: BoardView): readonly EntryOf<'hypothesis'>[] =>
  view
    .liveOfType('hypothesis')
    .filter(
      (h) =>
        view.evidenceSupporting(h.id).length === 0 && view.evidenceContradicting(h.id).length === 0,
    );

/** Live evidence not linked to any live hypothesis from either side. */
export const evidenceWithoutHypothesis = (view: BoardView): readonly EntryOf<'evidence'>[] => {
  const hypotheses = view.liveOfType('hypothesis');
  const referenced = new Set(
    hypotheses.flatMap((h) => [...h.payload.supportedBy, ...h.payload.contradictedBy]),
  );
  return view
    .liveOfType('evidence')
    .filter(
      (e) =>
        !referenced.has(e.id) &&
        ![...e.payload.supports, ...e.payload.contradicts].some((id) => view.isLive(id)),
    );
};

export const hypothesesWithoutCritique = (view: BoardView): readonly EntryOf<'hypothesis'>[] =>
  view.liveOfType('hypothesis').filter((h) => view.critiquesOf(h.id).length === 0);

/** Live hypotheses that received new evidence in or after `sinceRound`. */
export const hypothesesWithNewEvidence = (
  view: BoardView,
  sinceRound: number,
): readonly EntryOf<'hypothesis'>[] =>
  view
    .liveOfType('hypothesis')
    .filter((h) =>
      [...view.evidenceSupporting(h.id), ...view.evidenceContradicting(h.id)].some(
        (e) => e.round >= sinceRound,
      ),
    );

/** Live hypotheses with no open blocking critique against them. */
export const synthesisCandidates = (view: BoardView): readonly EntryOf<'hypothesis'>[] =>
  view
    .liveOfType('hypothesis')
    .filter(
      (h) =>
        !view
          .critiquesOf(h.id)
          .some((c) => c.payload.severity === 'blocking' && c.payload.resolvedBy === undefined),
    );

/** The live synthesis with the highest version, if any. */
export const latestSynthesis = (view: BoardView): EntryOf<'synthesis'> | undefined =>
  view
    .liveOfType('synthesis')
    .reduce<EntryOf<'synthesis'> | undefined>(
      (best, s) => (best === undefined || s.payload.version > best.payload.version ? s : best),
      undefined,
    );
