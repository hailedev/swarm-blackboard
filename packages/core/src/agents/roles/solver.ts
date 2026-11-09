import { z } from 'zod';

import { contributionSchemas, type ReferenceSchemas } from '../../schemas/contribution';
import { eligible, notEligible, type RoleDefinition } from '../agent';
import { evidenceWithoutHypothesis, openSubproblems } from '../eligibility';

/** Up to 6 hypotheses or subproblem status changes, linking only through `refs`. */
export const solverOutputSchema = (refs: ReferenceSchemas) => {
  const s = contributionSchemas(refs);
  return z.object({
    contributions: z.array(z.discriminatedUnion('type', [s.hypothesis, s.subproblem])).max(6),
  });
};

// Contributes hypotheses and subproblem work (claim / done via supersede).
// Eligible when subproblems are open or evidence has no hypothesis yet.
export const solver: RoleDefinition = {
  role: 'solver',
  outputSchema: solverOutputSchema,
  trigger(view) {
    const targets = [...openSubproblems(view), ...evidenceWithoutHypothesis(view)].map((e) => e.id);
    return targets.length > 0
      ? eligible(70, targets, 'open subproblems or unexplained evidence')
      : notEligible('nothing to solve');
  },
};
