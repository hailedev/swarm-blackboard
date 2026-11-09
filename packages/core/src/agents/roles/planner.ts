import { z } from 'zod';

import { contributionSchemas, type ReferenceSchemas } from '../../schemas/contribution';
import { eligible, notEligible, type RoleDefinition } from '../agent';
import { boardIsNew } from '../eligibility';

/** Up to 8 subproblems or questions, linking only through `refs`. */
export const plannerOutputSchema = (refs: ReferenceSchemas) => {
  const s = contributionSchemas(refs);
  return z.object({
    contributions: z.array(z.discriminatedUnion('type', [s.subproblem, s.question])).max(8),
  });
};

// Contributes subproblems and reframes. Eligible when the board is new or a stall
// has been detected.
export const planner: RoleDefinition = {
  role: 'planner',
  outputSchema: plannerOutputSchema,
  trigger(view, ctx) {
    const problem = view.problem();
    if (problem !== undefined && boardIsNew(view)) {
      return eligible(100, [problem.id], 'board is new');
    }
    if (ctx.flags.stallDetected) return eligible(90, [], 'stall detected: reframe');
    return notEligible('board already decomposed and no stall');
  },
};
