import { z } from 'zod';

import { AgentRoleSchema } from './role';

// agents.yaml (docs/budget-guardrails.md §1, ADR-0009). Agents are defined once; a
// profile chooses a model alias per role and one fallback for schema failures.

export const ProviderSchema = z.enum(['anthropic', 'ollama']);
export type Provider = z.infer<typeof ProviderSchema>;

/** Whether calls to this provider cost money. Only the API provider is billed. */
export const isPaidProvider = (provider: Provider): boolean => provider === 'anthropic';

export const ModelAliasSchema = z.object({
  provider: ProviderSchema,
  model: z.string().min(1),
  think: z.boolean().optional(),
  /** Context window to request from a local model; the provider layer has a default. */
  numCtx: z.int().min(1024).optional(),
});
export type ModelAlias = z.infer<typeof ModelAliasSchema>;

export const NO_FALLBACK = 'none';

export const ProfileSchema = z.object({
  fallback: z.string().min(1),
  roles: z.object({
    planner: z.string().min(1),
    researcher: z.string().min(1),
    solver: z.string().min(1),
    critic: z.string().min(1),
    synthesizer: z.string().min(1),
    bidder: z.string().min(1).optional(),
  }),
});
export type Profile = z.infer<typeof ProfileSchema>;

export const AgentDefinitionSchema = z.object({ prompt: z.string().min(1) });

export const RosterSchema = z.object({
  defaultProfile: z.string().min(1),
  models: z.record(z.string().min(1), ModelAliasSchema),
  profiles: z.record(z.string().min(1), ProfileSchema),
  agents: z.record(AgentRoleSchema, AgentDefinitionSchema),
});
export type Roster = z.infer<typeof RosterSchema>;

// A profile with every alias resolved. Stored on the run record so traces and evals
// stay reproducible after agents.yaml changes.
export const ResolvedModelSchema = ModelAliasSchema.extend({ alias: z.string().min(1) });
export type ResolvedModel = z.infer<typeof ResolvedModelSchema>;

export const RunProfileSchema = z.object({
  name: z.string().min(1),
  roles: z.object({
    planner: ResolvedModelSchema,
    researcher: ResolvedModelSchema,
    solver: ResolvedModelSchema,
    critic: ResolvedModelSchema,
    synthesizer: ResolvedModelSchema,
  }),
  bidder: ResolvedModelSchema.nullable(),
  fallback: ResolvedModelSchema.nullable(),
  /** True when any role, the bidder or the fallback is on a paid provider. */
  paid: z.boolean(),
});
export type RunProfile = z.infer<typeof RunProfileSchema>;
