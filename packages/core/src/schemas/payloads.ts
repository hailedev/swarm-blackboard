import { z, type ZodType } from 'zod';

import { ConfidenceSchema, IdSchema } from './common';

export const ENTRY_TYPES = [
  'problem',
  'subproblem',
  'hypothesis',
  'evidence',
  'critique',
  'question',
  'decision',
  'synthesis',
  'human_note',
] as const;
export const EntryTypeSchema = z.enum(ENTRY_TYPES);
export type EntryType = z.infer<typeof EntryTypeSchema>;

// Payloads that point at other entries are factories over a reference schema: stored
// entries reference by UUID (`IdSchema`), while the schema an agent's model sees
// references by handle, an enum of the handles visible to that agent (schemas/handle.ts).
// Both produce the same TypeScript shape, strings either way.
export type ReferenceSchema = ZodType<string>;

export const ProblemPayloadSchema = z.object({
  constraints: z.array(z.string()),
  successCriteria: z.array(z.string()),
});

export const SubproblemStatusSchema = z.enum(['open', 'claimed', 'done']);
export type SubproblemStatus = z.infer<typeof SubproblemStatusSchema>;
export const SubproblemPayloadSchema = z.object({ status: SubproblemStatusSchema });

// `resolves` names the critiques a hypothesis answers: the Solver sets it on the version
// that supersedes a critiqued hypothesis (docs/PLAN.md §2.3 step 7). It is a record, not a
// switch: a critique stops being open when its target is superseded, whoever names it; what
// the field adds is which critiques the new version claims to have answered, so the Critic
// can check the claim and a reader can count what was answered. `critiqueRef` is what the
// field may point at: for a model, the live critiques in its view.
export const hypothesisPayloadSchema = (ref: ReferenceSchema, critiqueRef: ReferenceSchema = ref) =>
  z.object({
    confidence: ConfidenceSchema,
    supportedBy: z.array(ref),
    contradictedBy: z.array(ref),
    resolves: z.array(critiqueRef).optional(),
  });
/** As stored: a hypothesis recorded before the field existed, or by a model that left it out, resolves nothing. */
export const HypothesisPayloadSchema = hypothesisPayloadSchema(IdSchema).extend({
  resolves: z.array(IdSchema).default([]),
});

export const evidencePayloadSchema = (ref: ReferenceSchema) =>
  z.object({
    source: z.string().min(1),
    supports: z.array(ref),
    contradicts: z.array(ref),
  });
export const EvidencePayloadSchema = evidencePayloadSchema(IdSchema);

export const CritiqueSeveritySchema = z.enum(['blocking', 'major', 'minor']);
export type CritiqueSeverity = z.infer<typeof CritiqueSeveritySchema>;
export const critiquePayloadSchema = (ref: ReferenceSchema) =>
  z.object({
    target: ref,
    severity: CritiqueSeveritySchema,
    resolvedBy: ref.optional(),
  });
export const CritiquePayloadSchema = critiquePayloadSchema(IdSchema);

export const questionPayloadSchema = (ref: ReferenceSchema) =>
  z.object({ answeredBy: ref.optional() });
export const QuestionPayloadSchema = questionPayloadSchema(IdSchema);

export const decisionPayloadSchema = (ref: ReferenceSchema) =>
  z.object({
    chosen: ref,
    rejected: z.array(ref),
    rationale: z.string().min(1),
  });
export const DecisionPayloadSchema = decisionPayloadSchema(IdSchema);

export const synthesisPayloadSchema = (ref: ReferenceSchema) =>
  z.object({
    version: z.int().min(1),
    confidence: ConfidenceSchema,
    cites: z.array(ref),
  });
// A synthesis written during the rounds is a draft; the one the controller has written
// from the whole board when the run ends is final (docs/PLAN.md §2.3 step 8). The stage is
// stamped by the controller and exists only on the stored payload: it is not in the factory
// above, so no model's output schema has the field and no agent can claim it. An entry
// recorded before the stage existed is a draft.
export const SynthesisStageSchema = z.enum(['draft', 'final']);
export type SynthesisStage = z.infer<typeof SynthesisStageSchema>;
export const SynthesisPayloadSchema = synthesisPayloadSchema(IdSchema).extend({
  stage: SynthesisStageSchema.default('draft'),
});

export const HumanNotePrioritySchema = z.enum(['low', 'normal', 'high']);
export type HumanNotePriority = z.infer<typeof HumanNotePrioritySchema>;
export const HumanNotePayloadSchema = z.object({ priority: HumanNotePrioritySchema });

export type ProblemPayload = z.infer<typeof ProblemPayloadSchema>;
export type SubproblemPayload = z.infer<typeof SubproblemPayloadSchema>;
export type HypothesisPayload = z.infer<typeof HypothesisPayloadSchema>;
export type EvidencePayload = z.infer<typeof EvidencePayloadSchema>;
export type CritiquePayload = z.infer<typeof CritiquePayloadSchema>;
export type QuestionPayload = z.infer<typeof QuestionPayloadSchema>;
export type DecisionPayload = z.infer<typeof DecisionPayloadSchema>;
export type SynthesisPayload = z.infer<typeof SynthesisPayloadSchema>;
export type HumanNotePayload = z.infer<typeof HumanNotePayloadSchema>;
