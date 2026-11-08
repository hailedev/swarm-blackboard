import { z } from 'zod';

import {
  HypothesisContributionSchema,
  SubproblemContributionSchema,
} from '../../schemas/contribution';
import { eligible, notEligible, type RoleDefinition } from '../agent';
import { evidenceWithoutHypothesis, openSubproblems } from '../eligibility';

export const SolverOutputSchema = z.object({
  contributions: z
    .array(
      z.discriminatedUnion('type', [HypothesisContributionSchema, SubproblemContributionSchema]),
    )
    .max(6),
});

// Contributes hypotheses and subproblem work (claim / done via supersede).
// Eligible when subproblems are open or evidence has no hypothesis yet.
export const solver: RoleDefinition = {
  role: 'solver',
  outputSchema: SolverOutputSchema,
  trigger(view) {
    const targets = [...openSubproblems(view), ...evidenceWithoutHypothesis(view)].map((e) => e.id);
    return targets.length > 0
      ? eligible(70, targets, 'open subproblems or unexplained evidence')
      : notEligible('nothing to solve');
  },
};
