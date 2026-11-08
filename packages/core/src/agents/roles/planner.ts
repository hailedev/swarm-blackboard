import { z } from 'zod';

import {
  QuestionContributionSchema,
  SubproblemContributionSchema,
} from '../../schemas/contribution';
import { eligible, notEligible, type RoleDefinition } from '../agent';
import { boardIsNew } from '../eligibility';

export const PlannerOutputSchema = z.object({
  contributions: z
    .array(z.discriminatedUnion('type', [SubproblemContributionSchema, QuestionContributionSchema]))
    .max(8),
});

// Contributes subproblems and reframes. Eligible when the board is new or a stall
// has been detected.
export const planner: RoleDefinition = {
  role: 'planner',
  outputSchema: PlannerOutputSchema,
  trigger(view, ctx) {
    const problem = view.problem();
    if (problem !== undefined && boardIsNew(view)) {
      return eligible(100, [problem.id], 'board is new');
    }
    if (ctx.flags.stallDetected) return eligible(90, [], 'stall detected: reframe');
    return notEligible('board already decomposed and no stall');
  },
};
