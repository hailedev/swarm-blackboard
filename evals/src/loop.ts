import {
  rejectedHypothesisIds,
  subproblemStatus,
  type BoardEvent,
  type BoardView,
  type CritiqueSeverity,
  type SubproblemStatus,
} from '@team/core';

// How far a run closed its loop (docs/PLAN.md §6 Phase 5, Step 2b): whether the critiques
// it raised were answered, whether replies were lost, whether subproblems were finished.
// Counted from the run's final board, its event log and its model calls. Nothing here is a
// judgement of quality: a critique "resolved" is one a hypothesis named as answered, which
// says that somebody replied to it, not that the reply was good.

export interface LoopFigures {
  critiques: {
    /** Every critique the run posted. */
    raised: number;
    /** Named by a hypothesis among the critiques it resolves, or marked resolved itself. */
    resolved: number;
    /**
     * Gone without anybody claiming to answer it: what it attacked was replaced, or
     * rejected by a decision, or the critique itself was replaced.
     */
    replaced: number;
    /** Still standing against a live entry when the run ended, by severity. */
    open: Record<CritiqueSeverity, number>;
  };
  /** The run's model calls, repairs and the write-up included; rejected = invalid output. */
  calls: { made: number; rejected: number };
  /** Replies longer than their role may post, cut to the limit instead of rejected. */
  trimmedReplies: number;
  decisions: number;
  /** Draft syntheses the Synthesizer posted during the rounds. */
  drafts: number;
  /** Live subproblems by where they stand, read off the board. */
  subproblems: Record<SubproblemStatus, number>;
  /** Hypotheses a decision rejected. */
  rejectedHypotheses: number;
}

export const loopFigures = (
  view: BoardView,
  events: readonly BoardEvent[],
  // The ledger stores the outcome as text (ModelCallOutcome, packages/core).
  calls: readonly { outcome: string }[],
): LoopFigures => {
  const rejected = rejectedHypothesisIds(view);
  const figures: LoopFigures = {
    critiques: { raised: 0, resolved: 0, replaced: 0, open: { blocking: 0, major: 0, minor: 0 } },
    calls: {
      made: calls.length,
      rejected: calls.filter((call) => call.outcome === 'invalid_output').length,
    },
    trimmedReplies: events.filter((e) => e.type === 'agent_failed' && e.reason === 'over_limit')
      .length,
    decisions: 0,
    drafts: 0,
    subproblems: { open: 0, claimed: 0, done: 0 },
    rejectedHypotheses: rejected.size,
  };
  for (const entry of view.entries) {
    if (entry.type === 'decision') figures.decisions += 1;
    if (entry.type === 'synthesis' && entry.payload.stage === 'draft') figures.drafts += 1;
    if (entry.type === 'subproblem' && view.isLive(entry.id)) {
      figures.subproblems[subproblemStatus(view, entry)] += 1;
    }
    if (entry.type !== 'critique') continue;
    figures.critiques.raised += 1;
    if (entry.payload.resolvedBy !== undefined || view.resolutionOf(entry.id) !== undefined) {
      figures.critiques.resolved += 1;
    } else if (
      view.isLive(entry.id) &&
      view.isLive(entry.payload.target) &&
      !rejected.has(entry.payload.target)
    ) {
      figures.critiques.open[entry.payload.severity] += 1;
    } else {
      figures.critiques.replaced += 1;
    }
  }
  return figures;
};

/** "3 blocking, 1 major" for the critiques still standing; "none" when there are none. */
export const describeOpenCritiques = (open: LoopFigures['critiques']['open']): string => {
  const parts = (['blocking', 'major', 'minor'] as const)
    .filter((severity) => open[severity] > 0)
    .map((severity) => `${String(open[severity])} ${severity}`);
  return parts.length === 0 ? 'none' : parts.join(', ');
};
