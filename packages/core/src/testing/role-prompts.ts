import { AGENT_ROLES, type AgentRole } from '../schemas/role';

// Stand-in system prompts for core tests. The real role prompts are documents under
// prompts/ that the host loads; core never embeds them.
export const testRolePrompts = (): Record<AgentRole, string> =>
  Object.fromEntries(
    AGENT_ROLES.map((role) => [role, `Test stand-in for the ${role} prompt.`]),
  ) as Record<AgentRole, string>;
