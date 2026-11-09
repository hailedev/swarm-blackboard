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

export const hypothesisPayloadSchema = (ref: ReferenceSchema) =>
  z.object({
    confidence: ConfidenceSchema,
    supportedBy: z.array(ref),
    contradictedBy: z.array(ref),
  });
export const HypothesisPayloadSchema = hypothesisPayloadSchema(IdSchema);

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
export const SynthesisPayloadSchema = synthesisPayloadSchema(IdSchema);

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
