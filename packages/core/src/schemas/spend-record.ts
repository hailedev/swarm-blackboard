import { z } from 'zod';

import { IsoDateSchema, UsageSchema } from './common';

// One paid model call as the spend ledger sees it (docs/budget-guardrails.md §3): the
// JSONL line in Phase 2, a model_calls row in Phase 3.
export const SpendRecordSchema = z
  .object({
    at: IsoDateSchema,
    runId: z.string().min(1),
    role: z.string().min(1),
    modelId: z.string().min(1),
  })
  .extend(UsageSchema.shape);
export type SpendRecord = z.infer<typeof SpendRecordSchema>;
