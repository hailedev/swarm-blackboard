import { z } from 'zod';

import { IdSchema } from './common';
import {
  CritiquePayloadSchema,
  DecisionPayloadSchema,
  EvidencePayloadSchema,
  HypothesisPayloadSchema,
  QuestionPayloadSchema,
  SubproblemPayloadSchema,
  SynthesisPayloadSchema,
} from './payloads';

// What an agent returns. The controller stamps id, runId, round, author,
// createdAt, status and usage before the entry reaches the board.
// `problem` and `human_note` are never produced by agents, so they are not here.
export const ContributionBaseSchema = z.object({
  content: z.string().min(1),
  parents: z.array(IdSchema),
  supersedes: IdSchema.optional(),
});

export const SubproblemContributionSchema = ContributionBaseSchema.extend({
  type: z.literal('subproblem'),
  payload: SubproblemPayloadSchema,
});
export const HypothesisContributionSchema = ContributionBaseSchema.extend({
  type: z.literal('hypothesis'),
  payload: HypothesisPayloadSchema,
});
export const EvidenceContributionSchema = ContributionBaseSchema.extend({
  type: z.literal('evidence'),
  payload: EvidencePayloadSchema,
});
export const CritiqueContributionSchema = ContributionBaseSchema.extend({
  type: z.literal('critique'),
  payload: CritiquePayloadSchema,
});
export const QuestionContributionSchema = ContributionBaseSchema.extend({
  type: z.literal('question'),
  payload: QuestionPayloadSchema,
});
export const DecisionContributionSchema = ContributionBaseSchema.extend({
  type: z.literal('decision'),
  payload: DecisionPayloadSchema,
});
export const SynthesisContributionSchema = ContributionBaseSchema.extend({
  type: z.literal('synthesis'),
  payload: SynthesisPayloadSchema,
});

export const ContributionSchema = z.discriminatedUnion('type', [
  SubproblemContributionSchema,
  HypothesisContributionSchema,
  EvidenceContributionSchema,
  CritiqueContributionSchema,
  QuestionContributionSchema,
  DecisionContributionSchema,
  SynthesisContributionSchema,
]);

export type Contribution = z.infer<typeof ContributionSchema>;
export type ContributionType = Contribution['type'];
export type ContributionOf<T extends ContributionType> = Extract<Contribution, { type: T }>;
