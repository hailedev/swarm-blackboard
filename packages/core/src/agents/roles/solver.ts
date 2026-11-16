import { z } from 'zod';

import { contributionSchemas, type ModelReferenceSchemas } from '../../schemas/contribution';
import { eligible, notEligible, type RoleDefinition } from '../agent';
import { evidenceWithoutHypothesis, openSubproblems } from '../eligibility';

/**
 * Up to 6 hypotheses, linking only through `refs`. Hypotheses only: where a subproblem
 * stands is read off the board (`subproblemStatus`), so the Solver has no status to post.
 */
export const solverOutputSchema = (refs: ModelReferenceSchemas) =>
  z.object({ contributions: z.array(contributionSchemas(refs).hypothesis).max(6) });

// Contributes hypotheses. A subproblem is answered by a hypothesis that names it among its
// parents. Eligible when subproblems are open or evidence has no hypothesis yet.
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
