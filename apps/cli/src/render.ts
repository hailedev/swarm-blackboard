import {
  AGENT_ROLES,
  ENTRY_TYPES,
  isPaidProvider,
  type BoardView,
  type Entry,
  type ResolvedModel,
  type RunProfile,
  type RunStatus,
  type RunSummary,
} from '@team/core';

const oneLine = (text: string, max = 96): string => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
};

/** Entries are named by their board handles (H3, E7), the same names the agents use. */
type HandleOf = (id: string) => string;

const badge = (entry: Entry, h: HandleOf): string => {
  switch (entry.type) {
    case 'problem':
      return `${String(entry.payload.constraints.length)} constraints, ${String(entry.payload.successCriteria.length)} criteria`;
    case 'subproblem':
      return entry.payload.status;
    case 'hypothesis':
      return `conf ${entry.payload.confidence.toFixed(2)}, ${String(entry.payload.supportedBy.length)} for / ${String(entry.payload.contradictedBy.length)} against`;
    case 'evidence':
      return `source: ${entry.payload.source}; supports ${entry.payload.supports.map(h).join(' ') || '-'}`;
    case 'critique':
      return `${entry.payload.severity} -> ${h(entry.payload.target)}${entry.payload.resolvedBy === undefined ? '' : ' (resolved)'}`;
    case 'question':
      return entry.payload.answeredBy === undefined
        ? 'open'
        : `answered by ${h(entry.payload.answeredBy)}`;
    case 'decision':
      return `chose ${h(entry.payload.chosen)}, rejected ${entry.payload.rejected.map(h).join(' ')}`;
    case 'synthesis':
      return `v${String(entry.payload.version)}, conf ${entry.payload.confidence.toFixed(2)}, cites ${String(entry.payload.cites.length)}`;
    case 'human_note':
      return `priority ${entry.payload.priority}`;
  }
};

// Lanes by entry type (docs/PLAN.md §3), live entries only, with counts of what
// has been superseded or dismissed.
export const renderBoard = (view: BoardView): string[] => {
  const h: HandleOf = (id) => view.handleOf(id) ?? '?';
  const lines: string[] = [];
  for (const type of ENTRY_TYPES) {
    const all = view.entries.filter((entry) => entry.type === type);
    if (all.length === 0) continue;
    const live = view.liveOfType(type);
    const gone = all.length - live.length;
    lines.push(
      `-- ${type} (${String(live.length)} live${gone > 0 ? `, ${String(gone)} superseded or dismissed` : ''}) --`,
    );
    for (const entry of live) {
      const status = entry.status === 'active' ? '' : ` [${entry.status}]`;
      const supersedes =
        entry.supersedes === undefined ? '' : ` (supersedes ${h(entry.supersedes)})`;
      lines.push(
        `  ${h(entry.id).padEnd(4)} ${entry.author.padEnd(11)} r${String(entry.round)}  ${badge(entry, h)}${status}${supersedes}`,
      );
      lines.push(`        ${oneLine(entry.content)}`);
    }
  }
  return lines;
};

export const renderRoundHeader = (round: number, selected: readonly string[]): string =>
  `== Round ${String(round)}: ${selected.length === 0 ? 'nobody eligible' : selected.join(' + ')} ==`;

export const renderFailure = (agentId: string, reason: string, detail: string): string =>
  `  ! ${agentId} ${reason}: ${oneLine(detail, 160)}`;

const HEADING: Record<RunStatus, string> = {
  completed: 'Done',
  failed: 'Failed',
  paused: 'Paused',
  stopped: 'Stopped',
};

export const renderSummary = (summary: RunSummary): string[] => {
  const { totals } = summary;
  const tokens = totals.usage.inputTokens + totals.usage.outputTokens;
  const lines = [
    `== ${HEADING[summary.status]}: ${summary.reason} after ${String(summary.rounds)} rounds ==`,
    `entries ${String(totals.entries)} | tokens ${String(tokens)} | cost $${totals.usage.costUsd.toFixed(4)} | elapsed ${String(totals.elapsedMs)} ms`,
  ];
  const synthesis = summary.view.liveOfType('synthesis').at(-1);
  if (synthesis !== undefined) lines.push('', 'Answer:', synthesis.content);
  return lines;
};

export interface BudgetBannerInput {
  profile: RunProfile;
  maxCostUsd: number;
  month: { spentUsd: number; limitUsd: number; warnAtFraction: number };
  /** Scripted models are standing in for the profile's models. */
  fake: boolean;
}

const LABEL_WIDTH = 13;
const ALIAS_WIDTH = 12;

const modelRow = (label: string, model: ResolvedModel): string =>
  `  ${label.padEnd(LABEL_WIDTH)} ${model.alias.padEnd(ALIAS_WIDTH)} ${model.provider}/${model.model}${model.think === true ? ' (think)' : ''}${isPaidProvider(model.provider) ? '' : '  free'}`;

// What a paid profile will do before it does it (docs/budget-guardrails.md §5).
export const renderBudgetBanner = ({
  profile,
  maxCostUsd,
  month,
  fake,
}: BudgetBannerInput): string[] => {
  const lines = [`== Budget check: profile "${profile.name}" ==`];
  for (const role of AGENT_ROLES) lines.push(modelRow(role, profile.roles[role]));
  if (profile.bidder !== null) lines.push(modelRow('bidder', profile.bidder));
  lines.push(
    profile.fallback === null
      ? `  ${'fallback'.padEnd(LABEL_WIDTH)} none`
      : modelRow('fallback', profile.fallback),
  );
  lines.push(`  ${'per-run cap'.padEnd(LABEL_WIDTH)} $${maxCostUsd.toFixed(4)}`);
  const percent = month.limitUsd > 0 ? Math.round((month.spentUsd / month.limitUsd) * 100) : 100;
  const warning =
    month.spentUsd >= month.limitUsd * month.warnAtFraction
      ? `  ! past ${String(Math.round(month.warnAtFraction * 100))}% of the monthly limit`
      : '';
  lines.push(
    `  ${'this month'.padEnd(LABEL_WIDTH)} $${month.spentUsd.toFixed(4)} of $${month.limitUsd.toFixed(2)} (${String(percent)}%)${warning}`,
  );
  if (fake) lines.push('  --fake: scripted models stand in for these; nothing is billed.');
  return lines;
};
