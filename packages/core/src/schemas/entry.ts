import { z } from 'zod';

import {
  AuthorSchema,
  EntryStatusSchema,
  IdSchema,
  IsoDateSchema,
  RoundSchema,
  UsageSchema,
} from './common';
import {
  CritiquePayloadSchema,
  DecisionPayloadSchema,
  EvidencePayloadSchema,
  HumanNotePayloadSchema,
  HypothesisPayloadSchema,
  ProblemPayloadSchema,
  QuestionPayloadSchema,
  SubproblemPayloadSchema,
  SynthesisPayloadSchema,
  type EntryType,
} from './payloads';

// Fields shared by every board entry (docs/PLAN.md §2.1).
export const EntryBaseSchema = z.object({
  id: IdSchema,
  runId: IdSchema,
  round: RoundSchema,
  author: AuthorSchema,
  createdAt: IsoDateSchema,
  parents: z.array(IdSchema),
  supersedes: IdSchema.optional(),
  status: EntryStatusSchema,
  content: z.string().min(1),
  usage: UsageSchema,
});

export const ProblemEntrySchema = EntryBaseSchema.extend({
  type: z.literal('problem'),
  payload: ProblemPayloadSchema,
});
export const SubproblemEntrySchema = EntryBaseSchema.extend({
  type: z.literal('subproblem'),
  payload: SubproblemPayloadSchema,
});
export const HypothesisEntrySchema = EntryBaseSchema.extend({
  type: z.literal('hypothesis'),
  payload: HypothesisPayloadSchema,
});
export const EvidenceEntrySchema = EntryBaseSchema.extend({
  type: z.literal('evidence'),
  payload: EvidencePayloadSchema,
});
export const CritiqueEntrySchema = EntryBaseSchema.extend({
  type: z.literal('critique'),
  payload: CritiquePayloadSchema,
});
export const QuestionEntrySchema = EntryBaseSchema.extend({
  type: z.literal('question'),
  payload: QuestionPayloadSchema,
});
export const DecisionEntrySchema = EntryBaseSchema.extend({
  type: z.literal('decision'),
  payload: DecisionPayloadSchema,
});
export const SynthesisEntrySchema = EntryBaseSchema.extend({
  type: z.literal('synthesis'),
  payload: SynthesisPayloadSchema,
});
export const HumanNoteEntrySchema = EntryBaseSchema.extend({
  type: z.literal('human_note'),
  payload: HumanNotePayloadSchema,
});

export const EntrySchema = z.discriminatedUnion('type', [
  ProblemEntrySchema,
  SubproblemEntrySchema,
  HypothesisEntrySchema,
  EvidenceEntrySchema,
  CritiqueEntrySchema,
  QuestionEntrySchema,
  DecisionEntrySchema,
  SynthesisEntrySchema,
  HumanNoteEntrySchema,
]);

export type Entry = z.infer<typeof EntrySchema>;
export type EntryOf<T extends EntryType> = Extract<Entry, { type: T }>;
