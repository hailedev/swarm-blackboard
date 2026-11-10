import {
  HumanNotePrioritySchema,
  RunConfigSchema,
  RunEndReasonSchema,
  RunProfileSchema,
  RunStatusSchema,
  RunTotalsSchema,
} from '@team/core';
import { z } from 'zod';

// The API contract (CLAUDE.md: Zod at every boundary), exported as `@team/server/api`.
// The server validates request bodies with it and checks its handlers against the
// response schemas at compile time; the web app builds its forms from the request
// schemas and parses every response with the response schemas (ADR-0011).
//
// This module must stay loadable in a browser: core and Zod only.

// ── Requests ──────────────────────────────────────────────────────────────────────────

export const StartRunRequestSchema = z.object({
  problem: z.object({
    content: z.string().min(1),
    constraints: z.array(z.string()).optional(),
    successCriteria: z.array(z.string()).optional(),
  }),
  /** A profile from agents.yaml; the roster's default when absent. */
  profile: z.string().min(1).optional(),
  config: RunConfigSchema.optional(),
});
export type StartRunRequest = z.infer<typeof StartRunRequestSchema>;
/** What a client sends: every config field is optional and defaults on the server. */
export type StartRunBody = z.input<typeof StartRunRequestSchema>;

export const InjectNoteRequestSchema = z.object({
  content: z.string().min(1),
  priority: HumanNotePrioritySchema.default('normal'),
});
export type InjectNoteRequest = z.infer<typeof InjectNoteRequestSchema>;
export type InjectNoteBody = z.input<typeof InjectNoteRequestSchema>;

// ── Responses ─────────────────────────────────────────────────────────────────────────

/** The error envelope every non-2xx response carries. */
export const ApiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;

/** `running` while a controller loop owns the run, else how it paused or ended. */
export const RunRecordStatusSchema = z.enum(['running', ...RunStatusSchema.options]);
export type RunRecordStatus = z.infer<typeof RunRecordStatusSchema>;

/**
 * A run as the `runs` table has it. `reason` is null exactly while the run is running:
 * every paused, stopped, completed or failed run says why.
 */
export const RunRecordSchema = z.object({
  id: z.string(),
  problem: z.string(),
  status: RunRecordStatusSchema,
  reason: RunEndReasonSchema.nullable(),
  profileName: z.string().nullable(),
  config: RunConfigSchema,
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  totals: RunTotalsSchema,
});
export type RunRecord = z.infer<typeof RunRecordSchema>;

export const RunListResponseSchema = z.object({ runs: z.array(RunRecordSchema) });
export type RunListResponse = z.infer<typeof RunListResponseSchema>;

export const ProfilesResponseSchema = z.object({
  defaultProfile: z.string(),
  profiles: z.array(RunProfileSchema),
});
export type ProfilesResponse = z.infer<typeof ProfilesResponseSchema>;

/** Month-to-date API spend against the monthly limit (docs/budget-guardrails.md §3). */
export const BudgetResponseSchema = z.object({
  period: z.object({ start: z.string(), end: z.string() }),
  spentUsd: z.number(),
  limitUsd: z.number(),
  warnAtFraction: z.number(),
  timeZone: z.string(),
});
export type BudgetResponse = z.infer<typeof BudgetResponseSchema>;

/** A traced model call without its prompt and response bodies. */
export const ModelCallSummarySchema = z.object({
  id: z.string(),
  runId: z.string().nullable(),
  round: z.number().nullable(),
  role: z.string(),
  modelId: z.string(),
  /** `api` (billed), `local` or `fake`. */
  billing: z.string(),
  at: z.string(),
  /** `ok`, or the kind of error the call ended in. */
  outcome: z.string(),
  inputTokens: z.number().nullable(),
  outputTokens: z.number().nullable(),
  cacheReadTokens: z.number().nullable(),
  cacheWriteTokens: z.number().nullable(),
  /** The part of the output spent thinking; null for rows older than ADR-0013. */
  reasoningTokens: z.number().nullable(),
  costUsd: z.number().nullable(),
  estimateChars: z.number().nullable(),
  estimateCharsPerToken: z.number().nullable(),
  estimateTokens: z.number().nullable(),
  actualInputTokens: z.number().nullable(),
  latencyMs: z.number(),
  maxOutputTokens: z.number().nullable(),
  error: z.string().nullable(),
  warningsJson: z.string(),
  source: z.string(),
});
export type ModelCallSummary = z.infer<typeof ModelCallSummarySchema>;

export const TraceResponseSchema = z.object({
  runId: z.string(),
  calls: z.array(ModelCallSummarySchema),
});
export type TraceResponse = z.infer<typeof TraceResponseSchema>;

/** One traced call in full: what was sent and what came back. */
export const ModelCallDetailSchema = ModelCallSummarySchema.extend({
  system: z.string().nullable(),
  prompt: z.string().nullable(),
  responseJson: z.string().nullable(),
});
export type ModelCallDetail = z.infer<typeof ModelCallDetailSchema>;
