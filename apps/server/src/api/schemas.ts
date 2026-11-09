import { HumanNotePrioritySchema, RunConfigSchema } from '@team/core';
import { z } from 'zod';

// Request bodies, validated at the boundary (CLAUDE.md: Zod at every boundary). The web
// app (Phase 4) imports these to build its forms.

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

export const InjectNoteRequestSchema = z.object({
  content: z.string().min(1),
  priority: HumanNotePrioritySchema.default('normal'),
});
export type InjectNoteRequest = z.infer<typeof InjectNoteRequestSchema>;

/** The error envelope every non-2xx response carries. */
export const ApiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;
