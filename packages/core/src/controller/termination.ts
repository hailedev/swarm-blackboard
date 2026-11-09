import { latestSynthesis } from '../agents/eligibility';
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
}

/** The latest synthesis is confident and no blocking critique is open. */
export const synthesisReady = (view: BoardView, config: RunConfig): boolean => {
  const synthesis = latestSynthesis(view);
  return (
    synthesis !== undefined &&
    synthesis.payload.confidence >= config.synthesisThreshold &&
    view.openBlockingCritiques().length === 0
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
}: TerminationInput): RunEndReason | null => {
  if (synthesisReady(view, config) && !decisionRequired) return 'completed';
  if (budget !== null) return budget;
  if (starved) return 'budget_cost';
  if (stalled) return 'stalled';
  if (eligibleCount === 0) return 'no_eligible_agents';
  return null;
};
