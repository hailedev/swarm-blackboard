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

export interface ReferenceSchemas<P extends boolean = boolean> {
  /** Any entry the agent may point at: parents and every payload reference. */
  any: ReferenceSchema;
  /**
   * What a contribution of each type may supersede: a live entry of the same type. When a
   * type has no entry, the key is absent and the schema has no `supersedes` field at all.
   */
  liveOf: Partial<Record<ContributionType, ReferenceSchema>>;
  /**
   * Long-form content (the synthesis) as an array of paragraphs the controller joins with a
   * blank line: the shape a model answers against, because a local model under a JSON
   * `format` may never emit a line break inside a string (ADR-0008, third amendment). The
   * stored shape is one markdown string.
   */
  paragraphs: P;
}

/** The shape a model answers against: handle references, long-form content as paragraphs. */
export type ModelReferenceSchemas = ReferenceSchemas<true>;
/** The shape the controller commits: UUID references, content as one string. */
export type StoredReferenceSchemas = ReferenceSchemas<false>;

/** References as the controller stores them: UUIDs everywhere, any type may supersede. */
export const UUID_REFERENCES: StoredReferenceSchemas = {
  any: IdSchema,
  liveOf: Object.fromEntries(CONTRIBUTION_TYPES.map((type) => [type, IdSchema])),
  paragraphs: false,
};

/** UUID references with the model-facing content shape, for tests that let a model answer with ids. */
export const UUID_MODEL_REFERENCES: ModelReferenceSchemas = {
  ...UUID_REFERENCES,
  paragraphs: true,
};

const ContentSchema = z.string().min(1);
const ParagraphsSchema = z.array(z.string().min(1)).min(1);

const contributionOf = <T extends ContributionType, P extends ZodType, C extends ZodType>(
  refs: ReferenceSchemas,
  type: T,
  payload: P,
  content: C,
) => {
  const live = refs.liveOf[type];
  const full = z.object({
    type: z.literal(type),
    content,
    parents: z.array(refs.any),
    supersedes: (live ?? refs.any).optional(),
    payload,
  });
  // With nothing of this type to supersede the field is left out of the schema the model
  // sees. The static type keeps the optional key: an object without it still satisfies it.
  return (live === undefined ? full.omit({ supersedes: true }) : full) as typeof full;
};

// The long-form `content` schema is the only difference between the two shapes, so both
// are built here and the exported builders pick by `refs.paragraphs`, with overloads so
// each caller gets the exact type of the shape it asked for.
const schemasWith = <C extends ZodType>(refs: ReferenceSchemas, longForm: C) => ({
  subproblem: contributionOf(refs, 'subproblem', SubproblemPayloadSchema, ContentSchema),
  hypothesis: contributionOf(refs, 'hypothesis', hypothesisPayloadSchema(refs.any), ContentSchema),
  evidence: contributionOf(refs, 'evidence', evidencePayloadSchema(refs.any), ContentSchema),
  critique: contributionOf(refs, 'critique', critiquePayloadSchema(refs.any), ContentSchema),
  question: contributionOf(refs, 'question', questionPayloadSchema(refs.any), ContentSchema),
  decision: contributionOf(refs, 'decision', decisionPayloadSchema(refs.any), ContentSchema),
  synthesis: contributionOf(refs, 'synthesis', synthesisPayloadSchema(refs.any), longForm),
});
const unionWith = <C extends ZodType>(refs: ReferenceSchemas, longForm: C) => {
  const s = schemasWith(refs, longForm);
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

type StoredContributionSchemas = ReturnType<typeof schemasWith<typeof ContentSchema>>;
type ModelContributionSchemas = ReturnType<typeof schemasWith<typeof ParagraphsSchema>>;

export function contributionSchemas(refs: ModelReferenceSchemas): ModelContributionSchemas;
export function contributionSchemas(refs: StoredReferenceSchemas): StoredContributionSchemas;
export function contributionSchemas(
  refs: ReferenceSchemas,
): ModelContributionSchemas | StoredContributionSchemas {
  return refs.paragraphs ? schemasWith(refs, ParagraphsSchema) : schemasWith(refs, ContentSchema);
}

export function contributionSchema(
  refs: ModelReferenceSchemas,
): ReturnType<typeof unionWith<typeof ParagraphsSchema>>;
export function contributionSchema(
  refs: StoredReferenceSchemas,
): ReturnType<typeof unionWith<typeof ContentSchema>>;
export function contributionSchema(
  refs: ReferenceSchemas,
): ReturnType<typeof unionWith<typeof ParagraphsSchema | typeof ContentSchema>> {
  return refs.paragraphs ? unionWith(refs, ParagraphsSchema) : unionWith(refs, ContentSchema);
}

const uuid = contributionSchemas(UUID_REFERENCES);
export const SubproblemContributionSchema = uuid.subproblem;
export const HypothesisContributionSchema = uuid.hypothesis;
export const EvidenceContributionSchema = uuid.evidence;
export const CritiqueContributionSchema = uuid.critique;
export const QuestionContributionSchema = uuid.question;
export const DecisionContributionSchema = uuid.decision;
export const SynthesisContributionSchema = uuid.synthesis;
export const ContributionSchema = contributionSchema(UUID_REFERENCES);

/** A contribution as the controller commits it: ids for references, one string of content. */
export type Contribution = z.infer<typeof ContributionSchema>;
export type ContributionOf<T extends ContributionType> = Extract<Contribution, { type: T }>;

/** A contribution as a model returns it: references by handle, synthesis content in paragraphs. */
export const ModelContributionSchema = contributionSchema(UUID_MODEL_REFERENCES);
export type ModelContribution = z.infer<typeof ModelContributionSchema>;
export type ModelContributionOf<T extends ContributionType> = Extract<
  ModelContribution,
  { type: T }
>;
