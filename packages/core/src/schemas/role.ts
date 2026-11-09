import { z } from 'zod';

// The v1 roster (docs/PLAN.md §2.2). The bidder is a Phase 5 role that profiles may
// already name so that agents.yaml does not change shape when it arrives.
export const AGENT_ROLES = ['planner', 'researcher', 'solver', 'critic', 'synthesizer'] as const;
export const AgentRoleSchema = z.enum(AGENT_ROLES);
export type AgentRole = z.infer<typeof AgentRoleSchema>;

export const ROSTER_ROLES = [...AGENT_ROLES, 'bidder'] as const;
export const RosterRoleSchema = z.enum(ROSTER_ROLES);
export type RosterRole = z.infer<typeof RosterRoleSchema>;
