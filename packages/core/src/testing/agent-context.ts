import type { AgentContext, ControlFlags } from '../agents/agent';
import { defaultRunConfig, type RunConfigInput } from '../schemas/run-config';
import { RunConfigSchema } from '../schemas/run-config';

export interface AgentContextOverrides {
  runId?: string;
  round?: number;
  config?: RunConfigInput;
  flags?: Partial<ControlFlags>;
}

export const agentContext = (overrides: AgentContextOverrides = {}): AgentContext => ({
  runId: overrides.runId ?? 'run',
  round: overrides.round ?? 1,
  config:
    overrides.config === undefined ? defaultRunConfig() : RunConfigSchema.parse(overrides.config),
  flags: { stallDetected: false, criticForced: false, decisionRequired: false, ...overrides.flags },
});
