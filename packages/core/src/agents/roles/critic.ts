import { z } from 'zod';

import { contributionSchemas, type ReferenceSchemas } from '../../schemas/contribution';
import { eligible, notEligible, type RoleDefinition } from '../agent';
import { hypothesesWithNewEvidence, hypothesesWithoutCritique } from '../eligibility';

// Structurally unable to propose: the schema admits critiques and questions only (ADR-0005).
export const criticOutputSchema = (refs: ReferenceSchemas) => {
  const s = contributionSchemas(refs);
  return z.object({
    contributions: z.array(z.discriminatedUnion('type', [s.critique, s.question])).max(6),
  });
};

export const critic: RoleDefinition = {
  role: 'critic',
  outputSchema: criticOutputSchema,
  trigger(view, ctx) {
    const hypotheses = view.liveOfType('hypothesis').map((h) => h.id);
    if (ctx.flags.criticForced && hypotheses.length > 0) {
      return eligible(100, hypotheses, 'forced: live hypotheses contradict each other');
    }
    const uncritiqued = hypothesesWithoutCritique(view).map((h) => h.id);
    if (uncritiqued.length > 0) return eligible(80, uncritiqued, 'hypotheses without critique');
    const refreshed = hypothesesWithNewEvidence(view, Math.max(0, ctx.round - 1)).map((h) => h.id);
    if (refreshed.length > 0) return eligible(80, refreshed, 'new evidence on hypotheses');
    return notEligible('every hypothesis has been critiqued');
  },
};
