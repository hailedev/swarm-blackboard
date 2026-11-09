import { z, type ZodType } from 'zod';

import { IdSchema } from './common';
import {
  critiquePayloadSchema,
  decisionPayloadSchema,
  evidencePayloadSchema,
  hypothesisPayloadSchema,
  questionPayloadSchema,
  SubproblemPayloadSchema,
  synthesisPayloadSchema,
  type ReferenceSchema,
} from './payloads';

// What an agent returns. The controller stamps id, runId, round, author, createdAt,
// status and usage before the entry reaches the board. `problem` and `human_note` are
// never produced by agents, so they are not here.
//
// The schemas are factories over the reference schemas in play: the UUID constants below
// describe a contribution as the controller commits it; the schema a model answers against
// references entries by handle, with enums built per call from the agent's view
// (agents/handles.ts), so constrained decoding can only produce links that exist.

export const CONTRIBUTION_TYPES = [
  'subproblem',
  'hypothesis',
  'evidence',
  'critique',
  'question',
  'decision',
  'synthesis',
] as const;
export type ContributionType = (typeof CONTRIBUTION_TYPES)[number];

export interface ReferenceSchemas {
  /** Any entry the agent may point at: parents and every payload reference. */
  any: ReferenceSchema;
  /**
   * What a contribution of each type may supersede: a live entry of the same type. When a
   * type has no entry, the key is absent and the schema has no `supersedes` field at all.
   */
  liveOf: Partial<Record<ContributionType, ReferenceSchema>>;
}

/** References as the controller stores them: UUIDs everywhere, any type may supersede. */
export const UUID_REFERENCES: ReferenceSchemas = {
  any: IdSchema,
  liveOf: Object.fromEntries(CONTRIBUTION_TYPES.map((type) => [type, IdSchema])),
};

const contributionOf = <T extends ContributionType, P extends ZodType>(
  refs: ReferenceSchemas,
  type: T,
  payload: P,
) => {
  const live = refs.liveOf[type];
  const full = z.object({
    type: z.literal(type),
    content: z.string().min(1),
    parents: z.array(refs.any),
    supersedes: (live ?? refs.any).optional(),
    payload,
  });
  // With nothing of this type to supersede the field is left out of the schema the model
  // sees. The static type keeps the optional key: an object without it still satisfies it.
  return (live === undefined ? full.omit({ supersedes: true }) : full) as typeof full;
};

export const contributionSchemas = (refs: ReferenceSchemas) => ({
  subproblem: contributionOf(refs, 'subproblem', SubproblemPayloadSchema),
  hypothesis: contributionOf(refs, 'hypothesis', hypothesisPayloadSchema(refs.any)),
  evidence: contributionOf(refs, 'evidence', evidencePayloadSchema(refs.any)),
  critique: contributionOf(refs, 'critique', critiquePayloadSchema(refs.any)),
  question: contributionOf(refs, 'question', questionPayloadSchema(refs.any)),
  decision: contributionOf(refs, 'decision', decisionPayloadSchema(refs.any)),
  synthesis: contributionOf(refs, 'synthesis', synthesisPayloadSchema(refs.any)),
});

export const contributionSchema = (refs: ReferenceSchemas) => {
  const s = contributionSchemas(refs);
  return z.discriminatedUnion('type', [
    s.subproblem,
    s.hypothesis,
    s.evidence,
    s.critique,
    s.question,
    s.decision,
    s.synthesis,
  ]);
};

const uuid = contributionSchemas(UUID_REFERENCES);
export const SubproblemContributionSchema = uuid.subproblem;
export const HypothesisContributionSchema = uuid.hypothesis;
export const EvidenceContributionSchema = uuid.evidence;
export const CritiqueContributionSchema = uuid.critique;
export const QuestionContributionSchema = uuid.question;
export const DecisionContributionSchema = uuid.decision;
export const SynthesisContributionSchema = uuid.synthesis;
export const ContributionSchema = contributionSchema(UUID_REFERENCES);

export type Contribution = z.infer<typeof ContributionSchema>;
export type ContributionOf<T extends ContributionType> = Extract<Contribution, { type: T }>;
