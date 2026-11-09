import { isPaidProvider, type AgentRole, type ResolvedModel } from '@team/core';

import { compact, usd } from '../lib/format';
import { FAILURE_LABEL } from '../lib/reasons';
import type { AgentActivity, AgentSpend, AgentState } from '../state/selectors';
import { Badge, type Tone } from './ui';

// Each agent: what it is doing, which model backs it in this run, and what it has cost.
// (Bidding arrives in Phase 5; until then an agent is idle, running, or failed last time.)

const ACTIVITY: Record<AgentActivity, { tone: Tone; icon: string; label: string }> = {
  idle: { tone: 'neutral', icon: '○', label: 'idle' },
  running: { tone: 'accent', icon: '●', label: 'running' },
  failed: { tone: 'critical', icon: '✕', label: 'failed' },
};

export interface AgentPanelProps {
  agents: readonly AgentState[];
  /** The models the run resolved, or null when it recorded no profile. */
  models: Record<AgentRole, ResolvedModel> | null;
  spend: ReadonlyMap<string, AgentSpend>;
}

export const AgentPanel = ({ agents, models, spend }: AgentPanelProps) => (
  <ul data-testid="agent-panel" className="divide-y divide-line">
    {agents.map((agent) => {
      const model = models?.[agent.role];
      const used = spend.get(agent.role);
      const activity = ACTIVITY[agent.activity];
      return (
        <li
          key={agent.role}
          data-agent={agent.role}
          data-activity={agent.activity}
          className="px-3 py-2"
        >
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm font-medium capitalize">{agent.role}</span>
            <Badge tone={activity.tone} icon={activity.icon}>
              {activity.label}
            </Badge>
          </div>
          <p className="mt-0.5 text-xs text-ink-2">
            {model === undefined
              ? 'model not recorded'
              : `${model.alias} · ${model.provider}/${model.model} · ${isPaidProvider(model.provider) ? 'paid' : 'free'}`}
          </p>
          <p className="text-xs text-ink-2">
            {used === undefined
              ? 'no calls yet'
              : `${String(used.calls)} ${used.calls === 1 ? 'call' : 'calls'} · ${compact(used.tokens)} tokens · ${usd(used.costUsd)} · ${(used.latencyMs / used.calls / 1_000).toFixed(1)}s per call`}
            {agent.rounds === 0
              ? ''
              : ` · selected in ${String(agent.rounds)} ${agent.rounds === 1 ? 'round' : 'rounds'}`}
          </p>
          {agent.activity === 'failed' && agent.failure !== null ? (
            <p className="mt-1 text-xs break-words">
              Round {String(agent.failure.round)}: {FAILURE_LABEL[agent.failure.reason]}
              {agent.failure.detail === '' ? '' : ` — ${agent.failure.detail}`}
            </p>
          ) : null}
        </li>
      );
    })}
  </ul>
);
