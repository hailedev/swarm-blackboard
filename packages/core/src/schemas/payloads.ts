import { z } from 'zod';

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

export const ProblemPayloadSchema = z.object({
  constraints: z.array(z.string()),
  successCriteria: z.array(z.string()),
});

export const SubproblemStatusSchema = z.enum(['open', 'claimed', 'done']);
export type SubproblemStatus = z.infer<typeof SubproblemStatusSchema>;
export const SubproblemPayloadSchema = z.object({ status: SubproblemStatusSchema });

export const HypothesisPayloadSchema = z.object({
  confidence: ConfidenceSchema,
  supportedBy: z.array(IdSchema),
  contradictedBy: z.array(IdSchema),
});

export const EvidencePayloadSchema = z.object({
  source: z.string().min(1),
  supports: z.array(IdSchema),
  contradicts: z.array(IdSchema),
});

export const CritiqueSeveritySchema = z.enum(['blocking', 'major', 'minor']);
export type CritiqueSeverity = z.infer<typeof CritiqueSeveritySchema>;
export const CritiquePayloadSchema = z.object({
  target: IdSchema,
  severity: CritiqueSeveritySchema,
  resolvedBy: IdSchema.optional(),
});

export const QuestionPayloadSchema = z.object({ answeredBy: IdSchema.optional() });

export const DecisionPayloadSchema = z.object({
  chosen: IdSchema,
  rejected: z.array(IdSchema),
  rationale: z.string().min(1),
});

export const SynthesisPayloadSchema = z.object({
  version: z.int().min(1),
  confidence: ConfidenceSchema,
  cites: z.array(IdSchema),
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
