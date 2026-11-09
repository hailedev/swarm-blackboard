import type { BoardView } from '../board/board-view';
import { HANDLE_LEGEND, type Handle } from '../schemas/handle';
import type { AgentRole } from '../schemas/role';
import type { AgentContext } from './agent';
import { buildAgentView, handleOf, payloadDigest, type FocusEntry } from './agent-view';

// What an agent reads. The role's instructions come from prompts/<role>.md through the
// host and are the system prompt verbatim; this module only lays the board out, so the
// rendered prompt is a pure function of the board and can be snapshot-tested. Entries are
// named by handle; the handles the prompt names are the ones the agent may link to.
export interface RenderedPrompt {
  system: string;
  prompt: string;
  /** Every handle the prompt names, by type then ordinal. */
  handles: readonly Handle[];
}

const renderFocus = (view: BoardView, focus: FocusEntry): string[] => {
  const h = handleOf(view);
  const { entry } = focus;
  const lines = [
    `## [${entry.type}] ${h(entry.id)}${focus.isTarget ? ' (target)' : ''}`,
    `round ${String(entry.round)}, by ${entry.author}${entry.supersedes === undefined ? '' : `, supersedes ${h(entry.supersedes)}`}`,
  ];
  if (entry.parents.length > 0) lines.push(`parents: ${entry.parents.map(h).join(', ')}`);
  lines.push(
    payloadDigest(view, entry),
    `${focus.content}${focus.clipped ? ' …[clipped]' : ''}`,
    '',
  );
  return lines;
};

export const renderAgentPrompt = (
  role: AgentRole,
  view: BoardView,
  ctx: AgentContext,
  rolePrompt: string,
): RenderedPrompt => {
  const h = handleOf(view);
  const agentView = buildAgentView(view, role, ctx.targetIds, ctx.config.view);
  const lines: string[] = [`Round ${String(ctx.round)} of ${String(ctx.config.maxRounds)}.`, ''];

  const { problem } = agentView;
  if (problem === undefined) {
    lines.push('# Problem', '(no problem entry on the board)');
  } else {
    lines.push(`# Problem (${h(problem.id)})`, problem.content);
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
        (note) => `- ${h(note.id)} (priority ${note.payload.priority}): ${note.content}`,
      ),
    );
  }

  lines.push('', '# Entries in focus');
  if (agentView.focus.length === 0) lines.push('(none)', '');
  for (const focus of agentView.focus) lines.push(...renderFocus(view, focus));

  lines.push('# Rest of the board');
  lines.push(...(agentView.summary.length === 0 ? ['(nothing else)'] : agentView.summary));

  // Targets the board no longer knows (superseded since the trigger ran) are not named.
  const targets = ctx.targetIds.flatMap((id) => {
    const handle = view.handleOf(id);
    return handle === undefined ? [] : [handle];
  });
  lines.push(
    '',
    '# Your targets',
    targets.length === 0 ? '(none: act on the board as a whole)' : targets.join(', '),
  );

  const flags = Object.entries(ctx.flags)
    .filter(([, on]) => on)
    .map(([name]) => name);
  if (flags.length > 0) lines.push('', `Control flags: ${flags.join(', ')}`);

  lines.push(
    '',
    `Return JSON matching the schema. Reference entries only by the handles shown above (${HANDLE_LEGEND}), copied exactly.`,
  );
  return { system: rolePrompt, prompt: lines.join('\n'), handles: agentView.handles };
};

const MAX_RAW_CHARS = 4_000;
// A Zod enum issue lists every allowed value, which on a busy board is the whole handle set.
const MAX_ISSUE_CHARS = 200;

const clip = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max)}…`;

// Second attempt after a schema failure: the same board, plus what was wrong with the
// previous answer.
export const renderRepairPrompt = (
  prompt: string,
  failure: { issues: readonly string[]; raw: string },
): string =>
  [
    prompt,
    '',
    '# Your previous answer was rejected',
    'It did not match the required schema:',
    ...failure.issues.map((issue) => `- ${clip(issue, MAX_ISSUE_CHARS)}`),
    '',
    'Previous answer:',
    clip(failure.raw, MAX_RAW_CHARS),
    '',
    'Return a corrected answer that satisfies the schema. Reference entries only by the handles shown on the board, copied exactly.',
  ].join('\n');
