import { latestSynthesis } from '../agents/eligibility';
import type { BoardView } from '../board/board-view';
import type { TerminationReason } from '../schemas/event';
import type { RunConfig } from '../schemas/run-config';
import type { BudgetLimit } from './budgets';

export interface TerminationInput {
  view: BoardView;
  config: RunConfig;
  budget: BudgetLimit | null;
  stalled: boolean;
  eligibleCount: number;
}

// docs/PLAN.md §2.3 step 8, checked after every round in this order.
export const checkTermination = ({
  view,
  config,
  budget,
  stalled,
  eligibleCount,
}: TerminationInput): TerminationReason | null => {
  const synthesis = latestSynthesis(view);
  if (
    synthesis !== undefined &&
    synthesis.payload.confidence >= config.synthesisThreshold &&
    view.openBlockingCritiques().length === 0
  ) {
    return 'synthesis_confident';
  }
  if (budget !== null) return `budget:${budget}`;
  if (stalled) return 'stalled';
  if (eligibleCount === 0) return 'no_eligible_agents';
  return null;
};
