import type { BoardView } from '../board/board-view';
import type { Entry } from '../schemas/entry';
import type { AgentRole } from '../schemas/role';
import type { AgentContext } from './agent';

// Phase 1 placeholder renderer: a role line plus a compact dump of the live board.
// Phase 2 replaces it with prompts/<role>.md and the size-bounded board-view builder.

const payloadSummary = (entry: Entry): string => {
  switch (entry.type) {
    case 'problem':
      return `constraints=${String(entry.payload.constraints.length)} criteria=${String(entry.payload.successCriteria.length)}`;
    case 'subproblem':
      return `status=${entry.payload.status}`;
    case 'hypothesis':
      return `confidence=${String(entry.payload.confidence)} supportedBy=${String(entry.payload.supportedBy.length)} contradictedBy=${String(entry.payload.contradictedBy.length)}`;
    case 'evidence':
      return `source=${entry.payload.source} supports=${entry.payload.supports.join(',')} contradicts=${entry.payload.contradicts.join(',')}`;
    case 'critique':
      return `target=${entry.payload.target} severity=${entry.payload.severity}${entry.payload.resolvedBy === undefined ? '' : ' resolved'}`;
    case 'question':
      return entry.payload.answeredBy === undefined ? 'open' : 'answered';
    case 'decision':
      return `chosen=${entry.payload.chosen} rejected=${entry.payload.rejected.join(',')}`;
    case 'synthesis':
      return `version=${String(entry.payload.version)} confidence=${String(entry.payload.confidence)} cites=${String(entry.payload.cites.length)}`;
    case 'human_note':
      return `priority=${entry.payload.priority}`;
  }
};

const describeEntry = (entry: Entry): string =>
  `- [${entry.type}] ${entry.id} by ${entry.author} (round ${String(entry.round)}; ${payloadSummary(entry)}): ${entry.content}`;

export interface RenderedPrompt {
  system: string;
  prompt: string;
}

export const renderAgentPrompt = (
  role: AgentRole,
  view: BoardView,
  ctx: AgentContext,
): RenderedPrompt => {
  const problem = view.problem();
  const lines: string[] = [];
  lines.push(`Round ${String(ctx.round)} of ${String(ctx.config.maxRounds)}.`);
  if (problem !== undefined) {
    lines.push('', '# Problem', problem.content);
    if (problem.payload.constraints.length > 0) {
      lines.push('', 'Constraints:', ...problem.payload.constraints.map((c) => `- ${c}`));
    }
    if (problem.payload.successCriteria.length > 0) {
      lines.push('', 'Success criteria:', ...problem.payload.successCriteria.map((c) => `- ${c}`));
    }
  }
  const others = view.live.filter((entry) => entry.type !== 'problem');
  lines.push('', '# Live board');
  lines.push(...(others.length === 0 ? ['(empty)'] : others.map(describeEntry)));
  const flags = Object.entries(ctx.flags)
    .filter(([, on]) => on)
    .map(([name]) => name);
  if (flags.length > 0) lines.push('', `Control flags: ${flags.join(', ')}`);
  return {
    system: `You are the ${role} agent in a blackboard swarm. Read the board and return contributions as JSON matching the schema. Reference other entries by their ids.`,
    prompt: lines.join('\n'),
  };
};

const MAX_RAW_CHARS = 4_000;

// Second attempt after a schema failure: the same board, plus what was wrong with the
// previous answer. Placeholder wording until prompts/ lands with the role prompts.
export const renderRepairPrompt = (
  prompt: string,
  failure: { issues: readonly string[]; raw: string },
): string => {
  const raw =
    failure.raw.length <= MAX_RAW_CHARS ? failure.raw : `${failure.raw.slice(0, MAX_RAW_CHARS)}…`;
  return [
    prompt,
    '',
    '# Your previous answer was rejected',
    'It did not match the required schema:',
    ...failure.issues.map((issue) => `- ${issue}`),
    '',
    'Previous answer:',
    raw,
    '',
    'Return a corrected answer that satisfies the schema. Keep every id you reference exactly as it appears on the board.',
  ].join('\n');
};
