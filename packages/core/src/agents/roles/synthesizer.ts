import { z } from 'zod';

import { contributionSchemas, type ModelReferenceSchemas } from '../../schemas/contribution';
import {
  eligible,
  mandatory,
  notEligible,
  type AgentOutput,
  type ControlFlags,
  type RoleDefinition,
} from '../agent';
import { contradictingHypothesisIds } from '../conflicts';
import { boardChangedSinceLastSynthesis, synthesisCandidates } from '../eligibility';

/** How many contradictions one call may settle. */
export const MAX_DECISIONS_PER_CALL = 3;

/**
 * Exactly one synthesis, linking only through `refs`. While a decision is owed
 * (`decisionRequired`: live hypotheses contradict each other and the Critic has critiqued
 * them), up to three `decision` entries may come with it, and only then: a decision is how
 * a contradiction is settled, not something to post on a quiet board. Entries are committed
 * in the order given, so the decisions go first.
 */
export const synthesizerOutputSchema = (
  refs: ModelReferenceSchemas,
  flags?: ControlFlags,
): z.ZodType<AgentOutput> => {
  const s = contributionSchemas(refs);
  if (flags?.decisionRequired !== true) {
    return z.object({ contributions: z.array(s.synthesis).min(1).max(1) });
  }
  return z.object({
    contributions: z
      .array(z.discriminatedUnion('type', [s.decision, s.synthesis]))
      .min(1)
      .max(MAX_DECISIONS_PER_CALL + 1)
      .refine((items) => items.filter((item) => item.type === 'synthesis').length === 1, {
        message: 'exactly one synthesis is required, after the decisions',
      }),
  });
};

// Contributes the draft answer. Eligible when a hypothesis has no blocking critique, or
// from `synthesisFromRound` onwards regardless of board state (docs/PLAN.md §2.2). The
// decision gate (contested hypotheses need a `decision` first) applies only before that
// round: until Phase 5 nothing posts decisions, and the first real run showed the gate
// otherwise starving the run of any answer until the round cap. A synthesis the user asked
// for (`synthesisForced`) overrides all of it for one round: whatever the board holds.
//
// Deciding (docs/PLAN.md §2.3 step 7): when live hypotheses contradict each other and the
// Critic has critiqued them, a decision is owed. The Synthesizer is then eligible in any
// round, aimed at the contradicting hypotheses, and its schema admits `decision` entries
// beside the synthesis; the run cannot complete on a synthesis until the contradiction is
// decided (checkTermination).
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
    if (ctx.flags.decisionRequired) {
      // The hypotheses to decide between first, then the rest of what the answer rests on.
      const contradicting = contradictingHypothesisIds(view);
      return eligible(
        ctx.round >= ctx.config.synthesisFromRound ? 95 : 90,
        [...contradicting, ...candidates.filter((id) => !contradicting.includes(id))],
        'contradicting hypotheses critiqued: decide, then synthesise',
      );
    }
    if (ctx.round >= ctx.config.synthesisFromRound) {
      return eligible(95, candidates, `round ${String(ctx.round)} ≥ synthesisFromRound`);
    }
    if (candidates.length > 0)
      return eligible(50, candidates, 'hypotheses without blocking critique');
    return notEligible('no hypothesis is ready to synthesise');
  },
};
