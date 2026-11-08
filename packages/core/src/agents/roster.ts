import type { Model } from '../ports/model';
import { createRoleAgent, type Agent, type AgentRole } from './agent';
import { critic } from './roles/critic';
import { planner } from './roles/planner';
import { researcher } from './roles/researcher';
import { solver } from './roles/solver';
import { synthesizer } from './roles/synthesizer';

export const roleDefinitions = { planner, researcher, solver, critic, synthesizer } as const;

// Which model backs which role is configuration (agents.yaml, Phase 2); the roster
// only binds the models it is handed.
export const createDefaultAgents = (models: Readonly<Record<AgentRole, Model>>): Agent[] =>
  (Object.keys(roleDefinitions) as AgentRole[]).map((role) =>
    createRoleAgent(roleDefinitions[role], models[role]),
  );
