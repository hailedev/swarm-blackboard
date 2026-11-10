import { z } from 'zod';

import { contributionSchemas, type ModelReferenceSchemas } from '../../schemas/contribution';
import { eligible, notEligible, type RoleDefinition } from '../agent';
import { hypothesesLackingEvidence, openSubproblems } from '../eligibility';

/** Up to 6 evidence entries, linking only through `refs`. */
export const researcherOutputSchema = (refs: ModelReferenceSchemas) =>
  z.object({ contributions: z.array(contributionSchemas(refs).evidence).max(6) });

// Contributes evidence. Eligible when subproblems are open or hypotheses lack evidence.
export const researcher: RoleDefinition = {
  role: 'researcher',
  outputSchema: researcherOutputSchema,
  trigger(view) {
    const targets = [...openSubproblems(view), ...hypothesesLackingEvidence(view)].map((e) => e.id);
    return targets.length > 0
      ? eligible(60, targets, 'open subproblems or hypotheses lacking evidence')
      : notEligible('nothing to research');
  },
};
