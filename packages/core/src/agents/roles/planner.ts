import { z } from 'zod';

import { contributionSchemas, type ModelReferenceSchemas } from '../../schemas/contribution';
import { CONTRIBUTIONS_SCHEMA_MAX, eligible, notEligible, type RoleDefinition } from '../agent';
import { boardIsNew } from '../eligibility';

/** Subproblems or questions, linking only through `refs`; the role keeps the first 8. */
export const plannerOutputSchema = (refs: ModelReferenceSchemas) => {
  const s = contributionSchemas(refs);
  return z.object({
    contributions: z
      .array(z.discriminatedUnion('type', [s.subproblem, s.question]))
      .max(CONTRIBUTIONS_SCHEMA_MAX),
  });
};

// Contributes subproblems and reframes. Eligible when the board is new or a stall
// has been detected.
export const planner: RoleDefinition = {
  role: 'planner',
  outputSchema: plannerOutputSchema,
  limit: { max: 8 },
  trigger(view, ctx) {
    const problem = view.problem();
    if (problem !== undefined && boardIsNew(view)) {
      return eligible(100, [problem.id], 'board is new');
    }
    if (ctx.flags.stallDetected) return eligible(90, [], 'stall detected: reframe');
    return notEligible('board already decomposed and no stall');
  },
};
