import {
  latestSynthesis,
  openContestingCritiques,
  synthesisIsCurrent,
} from '../agents/eligibility';
import type { BoardView } from '../board/board-view';
import type { RunConfig } from '../schemas/run-config';
import type { RunBudgetReason, RunEndReason } from '../schemas/run-end';

export interface TerminationInput {
  view: BoardView;
  config: RunConfig;
  budget: RunBudgetReason | null;
  /** Every selected agent was refused a model call because no call fits the cost cap. */
  starved: boolean;
  stalled: boolean;
  eligibleCount: number;
  /**
   * An undecided contradiction stands (docs/PLAN.md §2.3 step 7). Until Phase 5 adds the
   * decision flow nothing resolves it, so no synthesis can complete the run while it
   * stands, however confident the Synthesizer is.
   */
  decisionRequired: boolean;
  /**
   * The Critic would be eligible on the board as this round left it: a standing version it
   * has not looked at, or one that has had evidence since (its trigger, agents/roles/critic.ts).
   * False for a roster with no Critic.
   */
  criticPending: boolean;
}

/**
 * A synthesis may end the run when all of this holds:
 *
 * - it is confident (`synthesisThreshold`);
 * - no blocking or major critique is open: the same set the Solver is sent back for and
 *   that keeps a subproblem from counting as done;
 * - it was written after the last hypothesis or critique landed, so its confidence was set
 *   with everything in view;
 *
 * and, checked beside it in `checkTermination`, the Critic has nothing left to review on
 * the standing versions and no contradiction is undecided.
 *
 * Until 2026-11-17 only a blocking critique held a run. A rehearsal run then completed in
 * four rounds on a draft at 0.85 written in the very round the Critic raised six major
 * critiques against the versions it rested on: none was ever answered. Waiting for the
 * majors alone would have ended it one round later on that same stale draft, once the
 * Solver had replaced the hypotheses; hence the last two conditions. A run that never
 * gets there ends on a budget, and is written up all the same.
 */
export const synthesisReady = (view: BoardView, config: RunConfig): boolean => {
  const synthesis = latestSynthesis(view);
  return (
    synthesis !== undefined &&
    synthesis.payload.confidence >= config.synthesisThreshold &&
    openContestingCritiques(view).length === 0 &&
    synthesisIsCurrent(view)
  );
};

// docs/PLAN.md §2.3 step 8, checked after every round in this order.
export const checkTermination = ({
  view,
  config,
  budget,
  starved,
  stalled,
  eligibleCount,
  decisionRequired,
  criticPending,
}: TerminationInput): RunEndReason | null => {
  if (synthesisReady(view, config) && !decisionRequired && !criticPending) return 'completed';
  if (budget !== null) return budget;
  if (starved) return 'budget_cost';
  if (stalled) return 'stalled';
  if (eligibleCount === 0) return 'no_eligible_agents';
  return null;
};
