import { z } from 'zod';

import { contributionSchemas, type ModelReferenceSchemas } from '../../schemas/contribution';
import { CONTRIBUTIONS_SCHEMA_MAX, eligible, notEligible, type RoleDefinition } from '../agent';
import { hypothesesLackingEvidence, openSubproblems } from '../eligibility';

/** Evidence entries, linking only through `refs`; the role keeps the first 6. */
export const researcherOutputSchema = (refs: ModelReferenceSchemas) =>
  z.object({
    contributions: z.array(contributionSchemas(refs).evidence).max(CONTRIBUTIONS_SCHEMA_MAX),
  });

// Contributes evidence. Eligible when subproblems are open or hypotheses lack evidence.
export const researcher: RoleDefinition = {
  role: 'researcher',
  outputSchema: researcherOutputSchema,
  limit: { max: 6 },
  trigger(view) {
    const targets = [...openSubproblems(view), ...hypothesesLackingEvidence(view)].map((e) => e.id);
    return targets.length > 0
      ? eligible(60, targets, 'open subproblems or hypotheses lacking evidence')
      : notEligible('nothing to research');
  },
};
