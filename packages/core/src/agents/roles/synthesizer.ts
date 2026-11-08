import { z } from 'zod';

import { SynthesisContributionSchema } from '../../schemas/contribution';
import { eligible, notEligible, type RoleDefinition } from '../agent';
import { synthesisCandidates } from '../eligibility';

export const SynthesizerOutputSchema = z.object({
  contributions: z.array(SynthesisContributionSchema).min(1).max(1),
});

// Contributes the draft answer. Eligible when a hypothesis has no blocking critique,
// or from `synthesisFromRound` onwards; gated while a decision is required.
export const synthesizer: RoleDefinition = {
  role: 'synthesizer',
  outputSchema: SynthesizerOutputSchema,
  trigger(view, ctx) {
    if (ctx.flags.decisionRequired) {
      return notEligible('contested hypotheses need a decision before synthesis');
    }
    const candidates = synthesisCandidates(view).map((h) => h.id);
    if (ctx.round >= ctx.config.synthesisFromRound) {
      return eligible(95, candidates, `round ${String(ctx.round)} ≥ synthesisFromRound`);
    }
    if (candidates.length > 0)
      return eligible(50, candidates, 'hypotheses without blocking critique');
    return notEligible('no hypothesis is ready to synthesise');
  },
};
