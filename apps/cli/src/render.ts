import { ENTRY_TYPES, type BoardView, type Entry, type RunSummary } from '@team/core';

export const shortId = (id: string): string => `#${id.slice(-4)}`;

const oneLine = (text: string, max = 96): string => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
};

const badge = (entry: Entry): string => {
  switch (entry.type) {
    case 'problem':
      return `${String(entry.payload.constraints.length)} constraints, ${String(entry.payload.successCriteria.length)} criteria`;
    case 'subproblem':
      return entry.payload.status;
    case 'hypothesis':
      return `conf ${entry.payload.confidence.toFixed(2)}, ${String(entry.payload.supportedBy.length)} for / ${String(entry.payload.contradictedBy.length)} against`;
    case 'evidence':
      return `source: ${entry.payload.source}; supports ${entry.payload.supports.map(shortId).join(' ') || '-'}`;
    case 'critique':
      return `${entry.payload.severity} -> ${shortId(entry.payload.target)}${entry.payload.resolvedBy === undefined ? '' : ' (resolved)'}`;
    case 'question':
      return entry.payload.answeredBy === undefined
        ? 'open'
        : `answered by ${shortId(entry.payload.answeredBy)}`;
    case 'decision':
      return `chose ${shortId(entry.payload.chosen)}, rejected ${entry.payload.rejected.map(shortId).join(' ')}`;
    case 'synthesis':
      return `v${String(entry.payload.version)}, conf ${entry.payload.confidence.toFixed(2)}, cites ${String(entry.payload.cites.length)}`;
    case 'human_note':
      return `priority ${entry.payload.priority}`;
  }
};

// Lanes by entry type (docs/PLAN.md §3), live entries only, with counts of what
// has been superseded or dismissed.
export const renderBoard = (view: BoardView): string[] => {
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
        entry.supersedes === undefined ? '' : ` (supersedes ${shortId(entry.supersedes)})`;
      lines.push(
        `  ${shortId(entry.id)} ${entry.author.padEnd(11)} r${String(entry.round)}  ${badge(entry)}${status}${supersedes}`,
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

export const renderSummary = (summary: RunSummary): string[] => {
  const { totals } = summary;
  const tokens = totals.usage.inputTokens + totals.usage.outputTokens;
  const lines = [
    `== Done: ${summary.reason} after ${String(summary.rounds)} rounds ==`,
    `entries ${String(totals.entries)} | tokens ${String(tokens)} | cost $${totals.usage.costUsd.toFixed(4)} | elapsed ${String(totals.elapsedMs)} ms`,
  ];
  const synthesis = summary.view.liveOfType('synthesis').at(-1);
  if (synthesis !== undefined) lines.push('', 'Answer:', synthesis.content);
  return lines;
};
