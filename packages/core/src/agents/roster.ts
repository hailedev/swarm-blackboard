import type { Model } from '../ports/model';
import type { AgentRole } from '../schemas/role';
import { createRoleAgent, type Agent } from './agent';
import { critic } from './roles/critic';
import { planner } from './roles/planner';
import { researcher } from './roles/researcher';
import { solver } from './roles/solver';
import { synthesizer } from './roles/synthesizer';

export const roleDefinitions = { planner, researcher, solver, critic, synthesizer } as const;

// Which model backs which role is configuration (agents.yaml, ADR-0009); the roster
// only binds the models it is handed. The fallback is one model for the whole profile.
export const createDefaultAgents = (
  models: Readonly<Record<AgentRole, Model>>,
  fallback?: Model,
): Agent[] =>
  (Object.keys(roleDefinitions) as AgentRole[]).map((role) =>
    createRoleAgent(roleDefinitions[role], { model: models[role], fallback }),
  );
