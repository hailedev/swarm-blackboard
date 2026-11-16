import { z } from 'zod';

import { contributionSchemas, type ModelReferenceSchemas } from '../../schemas/contribution';
import type { Contribution } from '../../schemas/contribution';
import { CONTRIBUTIONS_SCHEMA_MAX, eligible, notEligible, type RoleDefinition } from '../agent';
import {
  hypothesesWithNewEvidence,
  hypothesesWithoutCritique,
  SEVERITY_RANK,
} from '../eligibility';

// Structurally unable to propose: the schema admits critiques and questions only (ADR-0005).
export const criticOutputSchema = (refs: ModelReferenceSchemas) => {
  const s = contributionSchemas(refs);
  return z.object({
    contributions: z
      .array(z.discriminatedUnion('type', [s.critique, s.question]))
      .max(CONTRIBUTIONS_SCHEMA_MAX),
  });
};

// What the Critic keeps when it returns more than six: the most severe critiques first
// (blocking, major, minor), then questions.
const QUESTION_RANK = 3;
const importance = (contribution: Contribution): number =>
  contribution.type === 'critique' ? SEVERITY_RANK[contribution.payload.severity] : QUESTION_RANK;

export const critic: RoleDefinition = {
  role: 'critic',
  outputSchema: criticOutputSchema,
  limit: { max: 6, rank: (a, b) => importance(a) - importance(b) },
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
