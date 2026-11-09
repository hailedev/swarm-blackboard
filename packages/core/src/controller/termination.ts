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
}

// docs/PLAN.md §2.3 step 8, checked after every round in this order.
export const checkTermination = ({
  view,
  config,
  budget,
  starved,
  stalled,
  eligibleCount,
}: TerminationInput): RunEndReason | null => {
  const synthesis = latestSynthesis(view);
  if (
    synthesis !== undefined &&
    synthesis.payload.confidence >= config.synthesisThreshold &&
    view.openBlockingCritiques().length === 0
  ) {
    return 'completed';
  }
  if (budget !== null) return budget;
  if (starved) return 'budget_cost';
  if (stalled) return 'stalled';
  if (eligibleCount === 0) return 'no_eligible_agents';
  return null;
};
