import { z } from 'zod';

import { contributionSchemas, type ModelReferenceSchemas } from '../../schemas/contribution';
import type { Contribution } from '../../schemas/contribution';
import {
  CONTRIBUTIONS_SCHEMA_MAX,
  eligible,
  mandatory,
  notEligible,
  type RoleDefinition,
} from '../agent';
import { contradictingHypothesisIds } from '../conflicts';
import { hypothesesToReview, SEVERITY_RANK } from '../eligibility';

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

/**
 * How many hypotheses one call reviews. The call counts as a review of every target, so the
 * targets have to be what the view shows in full (RunConfig.view) and what six contributions
 * can cover; the rest wait for the next call.
 */
export const MAX_REVIEWS_PER_CALL = 6;

export const critic: RoleDefinition = {
  role: 'critic',
  outputSchema: criticOutputSchema,
  limit: { max: 6, rank: (a, b) => importance(a) - importance(b) },
  trigger(view, ctx) {
    // Forced by a contradiction: certain to run, and aimed at the hypotheses that
    // contradict each other. Aimed at every live hypothesis, as it was, a forced Critic
    // wrote more critiques than it may post; its reply was rejected, the contradiction
    // never counted as critiqued, and it was forced again the next round, to the end of
    // one step2a run. The fallback to all live hypotheses is for a flag set without a
    // contradiction on the board.
    const hypotheses = view.liveOfType('hypothesis').map((h) => h.id);
    if (ctx.flags.criticForced && hypotheses.length > 0) {
      const contradicting = contradictingHypothesisIds(view);
      return mandatory(
        contradicting.length > 0 ? contradicting : hypotheses,
        'forced: live hypotheses contradict each other',
      );
    }
    // Otherwise the versions it has not looked at yet, or that have had evidence since it
    // did. Being called on a hypothesis is what counts as reviewing it, whether or not it
    // finds anything to raise, so a clean hypothesis is reviewed once, not every other
    // round, and "nothing left to review" is something the board can say.
    const toReview = hypothesesToReview(view)
      .slice(0, MAX_REVIEWS_PER_CALL)
      .map((h) => h.id);
    return toReview.length > 0
      ? eligible(80, toReview, 'hypotheses not yet reviewed, or with new evidence')
      : notEligible('every standing hypothesis has been reviewed');
  },
};
