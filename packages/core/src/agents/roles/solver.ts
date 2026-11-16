import { z } from 'zod';

import { contributionSchemas, type ModelReferenceSchemas } from '../../schemas/contribution';
import { CONTRIBUTIONS_SCHEMA_MAX, eligible, notEligible, type RoleDefinition } from '../agent';
import { contestedHypotheses, evidenceWithoutHypothesis, openSubproblems } from '../eligibility';

/**
 * Hypotheses, linking only through `refs`; the role keeps the first 6. Hypotheses only: where a subproblem
 * stands is read off the board (`subproblemStatus`), so the Solver has no status to post.
 */
export const solverOutputSchema = (refs: ModelReferenceSchemas) =>
  z.object({
    contributions: z.array(contributionSchemas(refs).hypothesis).max(CONTRIBUTIONS_SCHEMA_MAX),
  });

/**
 * How many contested hypotheses one call is sent back to. An agent's view shows its targets
 * and their neighbours in full within fixed bounds (RunConfig.view), so a handful of
 * hypotheses with their critiques and evidence is what fits; the rest wait for the next call.
 */
export const MAX_CONTESTED_PER_CALL = 4;

// Contributes hypotheses. A subproblem is answered by a hypothesis that names it among its
// parents. Eligible when subproblems are open or evidence has no hypothesis yet, and, ahead
// of that new work, when a blocking or major critique stands against a live hypothesis: the
// Solver is sent back to it to post a version that supersedes it, answers the critiques and
// names the ones it resolves. Until the step2a runs nothing made anyone answer a critique:
// 0 of 52 were resolved, and in one run eight stood on live hypotheses while only the
// Synthesizer was eligible.
export const solver: RoleDefinition = {
  role: 'solver',
  outputSchema: solverOutputSchema,
  limit: { max: 6 },
  trigger(view) {
    const contested = contestedHypotheses(view)
      .slice(0, MAX_CONTESTED_PER_CALL)
      .map((h) => h.id);
    const fresh = [...openSubproblems(view), ...evidenceWithoutHypothesis(view)].map((e) => e.id);
    if (contested.length > 0) {
      return eligible(85, [...contested, ...fresh], 'critiques to answer on live hypotheses');
    }
    return fresh.length > 0
      ? eligible(70, fresh, 'open subproblems or unexplained evidence')
      : notEligible('nothing to solve');
  },
};
