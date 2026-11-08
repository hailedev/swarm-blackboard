import { z } from 'zod';

import { EvidenceContributionSchema } from '../../schemas/contribution';
import { eligible, notEligible, type RoleDefinition } from '../agent';
import { hypothesesLackingEvidence, openSubproblems } from '../eligibility';

export const ResearcherOutputSchema = z.object({
  contributions: z.array(EvidenceContributionSchema).max(6),
});

// Contributes evidence. Eligible when subproblems are open or hypotheses lack evidence.
export const researcher: RoleDefinition = {
  role: 'researcher',
  outputSchema: ResearcherOutputSchema,
  trigger(view) {
    const targets = [...openSubproblems(view), ...hypothesesLackingEvidence(view)].map((e) => e.id);
    return targets.length > 0
      ? eligible(60, targets, 'open subproblems or hypotheses lacking evidence')
      : notEligible('nothing to research');
  },
};
