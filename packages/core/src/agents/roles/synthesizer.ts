import { z } from 'zod';

import { contributionSchemas, type ModelReferenceSchemas } from '../../schemas/contribution';
import { eligible, mandatory, notEligible, type RoleDefinition } from '../agent';
import { boardChangedSinceLastSynthesis, synthesisCandidates } from '../eligibility';

/** Exactly one synthesis, linking only through `refs`. */
export const synthesizerOutputSchema = (refs: ModelReferenceSchemas) =>
  z.object({ contributions: z.array(contributionSchemas(refs).synthesis).min(1).max(1) });

// Contributes the draft answer. Eligible when a hypothesis has no blocking critique, or
// from `synthesisFromRound` onwards regardless of board state (docs/PLAN.md §2.2). The
// decision gate (contested hypotheses need a `decision` first) applies only before that
// round: until Phase 5 nothing posts decisions, and the first real run showed the gate
// otherwise starving the run of any answer until the round cap. A synthesis the user asked
// for (`synthesisForced`) overrides all of it for one round: whatever the board holds.
//
// It runs only when the board has changed since it last wrote. In one step2a run rounds 8
// to 12 selected the Synthesizer alone, and it rewrote its synthesis five times from an
// unchanged board at the same confidence. With nothing changed it is not eligible; if
// nobody else is either, the run ends there and the final write-up follows.
export const synthesizer: RoleDefinition = {
  role: 'synthesizer',
  outputSchema: synthesizerOutputSchema,
  trigger(view, ctx) {
    const candidates = synthesisCandidates(view).map((h) => h.id);
    if (ctx.flags.synthesisForced) return mandatory(candidates, 'forced by the user');
    if (!boardChangedSinceLastSynthesis(view)) {
      return notEligible('nothing has changed since the last synthesis');
    }
    if (ctx.round >= ctx.config.synthesisFromRound) {
      return eligible(
        95,
        candidates,
        `round ${String(ctx.round)} ≥ synthesisFromRound${ctx.flags.decisionRequired ? ' (decision still pending)' : ''}`,
      );
    }
    if (ctx.flags.decisionRequired) {
      return notEligible('contested hypotheses need a decision before synthesis');
    }
    if (candidates.length > 0)
      return eligible(50, candidates, 'hypotheses without blocking critique');
    return notEligible('no hypothesis is ready to synthesise');
  },
};
