import type { BoardView } from '../board/board-view';
import type { AgentRole } from '../schemas/role';
import type { AgentContext } from './agent';
import { buildAgentView, payloadDigest, type FocusEntry } from './agent-view';

// What an agent reads. The role's instructions come from prompts/<role>.md through the
// host and are the system prompt verbatim; this module only lays the board out, so the
// rendered prompt is a pure function of the board and can be snapshot-tested.
export interface RenderedPrompt {
  system: string;
  prompt: string;
}

const renderFocus = (focus: FocusEntry): string[] => {
  const { entry } = focus;
  const lines = [
    `## [${entry.type}] ${entry.id}${focus.isTarget ? ' (target)' : ''}`,
    `round ${String(entry.round)}, by ${entry.author}${entry.supersedes === undefined ? '' : `, supersedes ${entry.supersedes}`}`,
  ];
  if (entry.parents.length > 0) lines.push(`parents: ${entry.parents.join(', ')}`);
  lines.push(payloadDigest(entry), `${focus.content}${focus.clipped ? ' …[clipped]' : ''}`, '');
  return lines;
};

export const renderAgentPrompt = (
  role: AgentRole,
  view: BoardView,
  ctx: AgentContext,
  rolePrompt: string,
): RenderedPrompt => {
  const agentView = buildAgentView(view, role, ctx.targetIds, ctx.config.view);
  const lines: string[] = [`Round ${String(ctx.round)} of ${String(ctx.config.maxRounds)}.`, ''];

  const { problem } = agentView;
  if (problem === undefined) {
    lines.push('# Problem', '(no problem entry on the board)');
  } else {
    lines.push(`# Problem (id: ${problem.id})`, problem.content);
    if (problem.payload.constraints.length > 0) {
      lines.push('', 'Constraints:', ...problem.payload.constraints.map((c) => `- ${c}`));
    }
    if (problem.payload.successCriteria.length > 0) {
      lines.push('', 'Success criteria:', ...problem.payload.successCriteria.map((c) => `- ${c}`));
    }
  }

  if (agentView.humanNotes.length > 0) {
    lines.push(
      '',
      '# Human notes',
      ...agentView.humanNotes.map(
        (note) => `- ${note.id} (priority ${note.payload.priority}): ${note.content}`,
      ),
    );
  }

  lines.push('', '# Entries in focus');
  if (agentView.focus.length === 0) lines.push('(none)', '');
  for (const focus of agentView.focus) lines.push(...renderFocus(focus));

  lines.push('# Rest of the board');
  lines.push(...(agentView.summary.length === 0 ? ['(nothing else)'] : agentView.summary));

  lines.push(
    '',
    '# Your targets',
    ctx.targetIds.length === 0 ? '(none: act on the board as a whole)' : ctx.targetIds.join(', '),
  );

  const flags = Object.entries(ctx.flags)
    .filter(([, on]) => on)
    .map(([name]) => name);
  if (flags.length > 0) lines.push('', `Control flags: ${flags.join(', ')}`);

  lines.push(
    '',
    'Return JSON matching the schema. Reference entries only by ids shown above, copied exactly.',
  );
  return { system: rolePrompt, prompt: lines.join('\n') };
};

const MAX_RAW_CHARS = 4_000;

// Second attempt after a schema failure: the same board, plus what was wrong with the
// previous answer.
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
