import type { BoardView } from '../board/board-view';
import type { Entry, EntryOf } from '../schemas/entry';
import type { CritiqueSeverity, SubproblemStatus } from '../schemas/payloads';

// Pure predicates over the board, one per rule in docs/PLAN.md §2.2.

/** Nothing but the problem (and human notes) has been posted yet. */
export const boardIsNew = (view: BoardView): boolean =>
  view.live.every((entry) => entry.type === 'problem' || entry.type === 'human_note');

/** Most severe first: the order in which critiques are kept, shown and answered. */
export const SEVERITY_RANK: Readonly<Record<CritiqueSeverity, number>> = {
  blocking: 0,
  major: 1,
  minor: 2,
};

/** Critique severities that contest a hypothesis: it cannot be relied on until they are answered. */
export const CONTESTING: readonly CritiqueSeverity[] = ['blocking', 'major'];

/** The unresolved critiques of the given severities that stand against an entry. */
export const openCritiquesOf = (
  view: BoardView,
  id: string,
  severities: readonly CritiqueSeverity[] = CONTESTING,
): readonly EntryOf<'critique'>[] =>
  view
    .critiquesOf(id)
    .filter((c) => c.payload.resolvedBy === undefined && severities.includes(c.payload.severity));

/**
 * Hypotheses a live decision has rejected, and every later version of them: no longer
 * candidates for the answer. A decision settles between two lines of answers, not two
 * entries: the Solver may post a new version of a hypothesis in the very round the
 * Synthesizer rejects it, and that version is rejected with it.
 */
export const rejectedHypothesisIds = (view: BoardView): ReadonlySet<string> => {
  const rejected = new Set(view.liveOfType('decision').flatMap((d) => d.payload.rejected));
  if (rejected.size === 0) return rejected;
  // Commit order: a version always comes after the entry it supersedes.
  for (const entry of view.entries) {
    if (
      entry.type === 'hypothesis' &&
      entry.supersedes !== undefined &&
      rejected.has(entry.supersedes)
    ) {
      rejected.add(entry.id);
    }
  }
  return rejected;
};

/**
 * Whether a critique still stands: nothing has resolved it, it is live, and what it attacks
 * is live and has not been rejected by a decision. A critique closes when its target is
 * replaced (docs/PLAN.md §2.1); one that has closed cannot be claimed as resolved again.
 */
export const critiqueStands = (
  view: BoardView,
  critique: EntryOf<'critique'>,
  rejected: ReadonlySet<string> = rejectedHypothesisIds(view),
): boolean =>
  critique.payload.resolvedBy === undefined &&
  view.isLive(critique.id) &&
  view.isLive(critique.payload.target) &&
  !rejected.has(critique.payload.target);

/** Live hypotheses that are still in the running: no live decision has rejected them. */
export const standingHypotheses = (view: BoardView): readonly EntryOf<'hypothesis'>[] => {
  const rejected = rejectedHypothesisIds(view);
  return view.liveOfType('hypothesis').filter((h) => !rejected.has(h.id));
};

/**
 * Standing hypotheses that cannot be relied on yet: a blocking or major critique is open
 * against them. Worst first (a blocking critique before a major one), then in commit
 * order. These are what the Solver is sent back to (docs/PLAN.md §2.3 step 7).
 */
export const contestedHypotheses = (view: BoardView): readonly EntryOf<'hypothesis'>[] =>
  standingHypotheses(view)
    .map((hypothesis, index) => ({
      hypothesis,
      index,
      worst: Math.min(
        ...openCritiquesOf(view, hypothesis.id).map((c) => SEVERITY_RANK[c.payload.severity]),
      ),
    }))
    .filter(({ worst }) => Number.isFinite(worst))
    .sort((a, b) => a.worst - b.worst || a.index - b.index)
    .map(({ hypothesis }) => hypothesis);

/**
 * Where a subproblem stands, read off the board instead of posted by an agent (docs/PLAN.md
 * §2.1). The runs of 2026-11-16 showed that no model keeps these books: the Solver posted
 * `claimed` copies that superseded nothing, never marked a claimed subproblem `done`, and
 * left subproblems `open` for a whole run with hypotheses answering them. What is reliable
 * is that a hypothesis names the subproblems it answers among its parents. So:
 *
 * - `done`: a standing hypothesis (or an earlier version of it) is parented on the
 *   subproblem (or an earlier version of it) and no blocking or major critique stands
 *   against that hypothesis;
 * - `claimed`: such a hypothesis exists, but every one of them is contested;
 * - otherwise what the entry itself says: `open` for a subproblem as the Planner posts it,
 *   or whatever a log recorded before this rule.
 */
export const subproblemStatus = (
  view: BoardView,
  subproblem: EntryOf<'subproblem'>,
): SubproblemStatus => {
  const answering = standingAnswers(view, subproblem);
  if (answering.length === 0) return subproblem.payload.status;
  return answering.some((h) => openCritiquesOf(view, h.id).length === 0) ? 'done' : 'claimed';
};

/**
 * The hypotheses that stand as the answer to a subproblem, in commit order: standing
 * hypotheses of which some version is parented on some version of the subproblem. One is
 * the rule; more than one are rivals a decision has yet to settle between.
 */
export const standingAnswers = (
  view: BoardView,
  subproblem: EntryOf<'subproblem'>,
): readonly EntryOf<'hypothesis'>[] => {
  const versions = new Set(view.chain(subproblem.id).map((version) => version.id));
  return standingHypotheses(view).filter((hypothesis) =>
    lineOf(view, hypothesis.id).some((version) =>
      version.parents.some((parent) => versions.has(parent)),
    ),
  );
};

/**
 * An entry and everything it supersedes, newest first: its own line back to the root.
 * Unlike `view.chain`, which follows the latest branch forward, this never leaves the line.
 */
export const lineOf = (view: BoardView, id: string): readonly Entry[] => {
  const line: Entry[] = [];
  let current = view.byId(id);
  while (current !== undefined && !line.includes(current)) {
    line.push(current);
    current = current.supersedes === undefined ? undefined : view.byId(current.supersedes);
  }
  return line;
};

/** Whether a hypothesis, in any version of its line, was posted as a rival answer. */
export const isDeclaredRival = (view: BoardView, hypothesisId: string): boolean =>
  lineOf(view, hypothesisId).some(
    (version) => version.type === 'hypothesis' && version.payload.rivalOf.length > 0,
  );

/** Live subproblems nothing answers yet. */
export const openSubproblems = (view: BoardView): readonly EntryOf<'subproblem'>[] =>
  view.liveOfType('subproblem').filter((s) => subproblemStatus(view, s) === 'open');

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

/**
 * Standing hypotheses the Critic still has to look at: versions no Critic call that returned
 * has been pointed at, and versions that have received evidence in or after the round of
 * their last review (evidence of that same round was posted beside the review, unseen by
 * it). A review that raised nothing counts: what the Critic was pointed at is on the log
 * (`agents_selected`), so "reviewed, nothing to raise" can be told from "never reviewed",
 * which the board's entries alone cannot do. When this is empty the Critic has nothing
 * left to review, and a run may end (controller/termination.ts).
 */
export const hypothesesToReview = (view: BoardView): readonly EntryOf<'hypothesis'>[] => {
  const lastReview = new Map<string, number>();
  for (const call of view.callsOf(CRITIC_ID)) {
    for (const id of call.targetIds) lastReview.set(id, call.round);
  }
  return standingHypotheses(view).filter((hypothesis) => {
    const reviewed = lastReview.get(hypothesis.id);
    if (reviewed === undefined) return true;
    return [
      ...view.evidenceSupporting(hypothesis.id),
      ...view.evidenceContradicting(hypothesis.id),
    ].some((evidence) => evidence.round >= reviewed);
  });
};

/** The Critic's agent id: the role name (agents/agent.ts, `createRoleAgent`). */
const CRITIC_ID = 'critic';

/**
 * Whether the latest synthesis was written after everything it should have read: after the
 * last hypothesis or critique landed. Every agent of a round reads the board as it stood
 * when the round began, so a synthesis has seen only what landed in earlier rounds; one
 * written in the round a critique was posted has not seen that critique.
 */
export const synthesisIsCurrent = (view: BoardView): boolean => {
  const synthesis = latestSynthesis(view);
  if (synthesis === undefined) return false;
  return view.entries.every(
    (entry) =>
      (entry.type !== 'hypothesis' && entry.type !== 'critique') || entry.round < synthesis.round,
  );
};

/** The open blocking and major critiques: what a run may not end with (rejected targets aside). */
export const openContestingCritiques = (view: BoardView): readonly EntryOf<'critique'>[] => {
  const rejected = rejectedHypothesisIds(view);
  return view
    .liveOfType('critique')
    .filter(
      (critique) =>
        CONTESTING.includes(critique.payload.severity) && critiqueStands(view, critique, rejected),
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

/** Standing hypotheses (not rejected by a decision) with no open blocking critique against them. */
export const synthesisCandidates = (view: BoardView): readonly EntryOf<'hypothesis'>[] =>
  standingHypotheses(view).filter(
    (h) =>
      !view
        .critiquesOf(h.id)
        .some((c) => c.payload.severity === 'blocking' && c.payload.resolvedBy === undefined),
  );

/**
 * Whether the board has moved since the Synthesizer last wrote: something other than a
 * synthesis was committed in or after the round of the most recently committed synthesis.
 * "In or after", because every agent of a round reads the board as it stood when the round
 * started: what the others posted in that same round is new to the Synthesizer. The most
 * recently committed synthesis, not the highest version: a model that forgets to supersede
 * leaves two drafts with one version number, and the newer is the one that saw more.
 * A decision is not a change either: only the Synthesizer posts them, in the same call as a
 * synthesis, so a decision that failed to settle a contradiction does not call it back to
 * try again on the same board. True when there is no synthesis yet.
 */
export const boardChangedSinceLastSynthesis = (view: BoardView): boolean => {
  const last = view.entries.findLast((entry) => entry.type === 'synthesis');
  if (last === undefined) return true;
  return view.entries.some(
    (entry) => entry.type !== 'synthesis' && entry.type !== 'decision' && entry.round >= last.round,
  );
};

/**
 * The live synthesis with the highest version, if any; of two with the same version, the
 * one committed later. A model that forgets to supersede leaves several drafts live under
 * one version number, and the newest is the one that read the most of the board.
 */
export const latestSynthesis = (view: BoardView): EntryOf<'synthesis'> | undefined =>
  view
    .liveOfType('synthesis')
    .reduce<EntryOf<'synthesis'> | undefined>(
      (best, s) => (best === undefined || s.payload.version >= best.payload.version ? s : best),
      undefined,
    );
