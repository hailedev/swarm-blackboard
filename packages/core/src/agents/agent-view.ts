import type { BoardView } from '../board/board-view';
import type { Entry, EntryOf } from '../schemas/entry';
import { compareHandles, type Handle } from '../schemas/handle';
import type { AgentRole } from '../schemas/role';
import type { ViewBounds } from '../schemas/run-config';
import { latestSynthesis } from './eligibility';

// The role-specific, size-bounded view an agent reads (docs/PLAN.md §2.2): the problem,
// the entries its trigger matched, their linked neighbours, and a rolling summary of
// everything else. A pure function of the materialised board, so the same board and
// bounds always render the same prompt and the prompt can be snapshot-tested.
//
// Entries are named by handle (H3, E7, …), never by id: the handles the view names are
// exactly the links the agent may make, and the model's output schema is an enum of them.

export interface FocusEntry {
  entry: Entry;
  /** Content, clipped to the per-entry bound. */
  content: string;
  clipped: boolean;
  isTarget: boolean;
}

export interface AgentView {
  problem: EntryOf<'problem'> | undefined;
  /** Always shown in full: the user's interventions outrank everything else. */
  humanNotes: readonly EntryOf<'human_note'>[];
  /** Targets first, then neighbours and role extras newest first, within the bounds. */
  focus: readonly FocusEntry[];
  /** One digest line per remaining live entry, newest first; the oldest collapse per type. */
  summary: readonly string[];
  /** Live entries that appear only in a collapsed tally. */
  omitted: number;
  /** Every handle the view names, by type then ordinal: the entries the agent may link to. */
  handles: readonly Handle[];
}

const SEPARATE_TYPES: ReadonlySet<Entry['type']> = new Set(['problem', 'human_note']);
const DIGEST_CONTENT_CHARS = 140;
const TALLY_IDS = 12;

/** Names an entry the way agents see it. An id the board does not know renders as "?". */
export type HandleOf = (id: string) => string;

export const handleOf =
  (view: BoardView): HandleOf =>
  (id) =>
    view.handleOf(id) ?? '?';

const list = (h: HandleOf, ids: readonly string[]): string => ids.map(h).join(',') || '-';

/** The entry ids an entry's payload points at, in the order the digest prints them. */
export const payloadReferences = (entry: Entry): string[] => {
  switch (entry.type) {
    case 'hypothesis':
      return [...entry.payload.supportedBy, ...entry.payload.contradictedBy];
    case 'evidence':
      return [...entry.payload.supports, ...entry.payload.contradicts];
    case 'critique':
      return [
        entry.payload.target,
        ...(entry.payload.resolvedBy === undefined ? [] : [entry.payload.resolvedBy]),
      ];
    case 'question':
      return entry.payload.answeredBy === undefined ? [] : [entry.payload.answeredBy];
    case 'decision':
      return [entry.payload.chosen, ...entry.payload.rejected];
    case 'synthesis':
      return [...entry.payload.cites];
    case 'problem':
    case 'subproblem':
    case 'human_note':
      return [];
  }
};

/** Every id an entry names: parents, what it supersedes and its payload references. */
export const referencedIds = (entry: Entry): string[] => [
  ...entry.parents,
  ...(entry.supersedes === undefined ? [] : [entry.supersedes]),
  ...payloadReferences(entry),
];

/** The type-specific fields of an entry on one line, for digests and focus headers. */
export const payloadDigest = (view: BoardView, entry: Entry): string => {
  const h = handleOf(view);
  switch (entry.type) {
    case 'problem':
      return `constraints=${String(entry.payload.constraints.length)} criteria=${String(entry.payload.successCriteria.length)}`;
    case 'subproblem':
      return `status=${entry.payload.status}`;
    case 'hypothesis':
      return `confidence=${String(entry.payload.confidence)} supportedBy=${list(h, entry.payload.supportedBy)} contradictedBy=${list(h, entry.payload.contradictedBy)}`;
    case 'evidence':
      return `source=${entry.payload.source} supports=${list(h, entry.payload.supports)} contradicts=${list(h, entry.payload.contradicts)}`;
    case 'critique':
      return `target=${h(entry.payload.target)} severity=${entry.payload.severity}${entry.payload.resolvedBy === undefined ? '' : ` resolvedBy=${h(entry.payload.resolvedBy)}`}`;
    case 'question':
      return entry.payload.answeredBy === undefined
        ? 'open'
        : `answeredBy=${h(entry.payload.answeredBy)}`;
    case 'decision':
      return `chosen=${h(entry.payload.chosen)} rejected=${list(h, entry.payload.rejected)}`;
    case 'synthesis':
      return `version=${String(entry.payload.version)} confidence=${String(entry.payload.confidence)} cites=${list(h, entry.payload.cites)}`;
    case 'human_note':
      return `priority=${entry.payload.priority}`;
  }
};

const oneLine = (text: string, max: number): string => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
};

/** One line for an entry outside the focus set; its payload links stay visible. */
export const digestLine = (view: BoardView, entry: Entry): string =>
  `[${entry.type}] ${handleOf(view)(entry.id)} r${String(entry.round)} by ${entry.author}: ${oneLine(entry.content, DIGEST_CONTENT_CHARS)}; ${payloadDigest(view, entry)}`;

const liveEntry = (view: BoardView, id: string): Entry | undefined => {
  const entry = view.byId(id);
  return entry !== undefined && view.isLive(id) ? entry : undefined;
};

// The entry that currently stands for `id`: follow supersede links to the end of the
// chain, which is the only version an agent may link to. Undefined when it was dismissed.
const liveSuccessor = (view: BoardView, id: string): Entry | undefined => {
  let current = view.byId(id);
  while (current !== undefined) {
    const next = view.supersededBy(current.id);
    if (next === undefined) break;
    current = next;
  }
  return current !== undefined && view.isLive(current.id) ? current : undefined;
};

const liveByIds = (view: BoardView, ids: readonly string[]): Entry[] =>
  ids.flatMap((id) => {
    const entry = liveSuccessor(view, id);
    return entry === undefined ? [] : [entry];
  });

// Everything linked to `entry` from either side: its parents and children, critiques of
// it, and whatever its own payload points at.
const neighboursOf = (view: BoardView, entry: Entry): Entry[] => {
  const out: Entry[] = [
    ...liveByIds(view, entry.parents),
    ...view.childrenOf(entry.id).filter((child) => view.isLive(child.id)),
    ...view.critiquesOf(entry.id),
  ];
  switch (entry.type) {
    case 'hypothesis':
      out.push(...view.evidenceSupporting(entry.id), ...view.evidenceContradicting(entry.id));
      break;
    case 'evidence':
    case 'critique':
    case 'decision':
    case 'synthesis':
    case 'question':
      out.push(...liveByIds(view, payloadReferences(entry)));
      break;
    case 'problem':
    case 'subproblem':
    case 'human_note':
      break;
  }
  return out;
};

// What a role needs beyond its targets' neighbourhood to act well.
const roleExtras = (view: BoardView, role: AgentRole): Entry[] => {
  switch (role) {
    case 'planner':
      return [
        ...view.liveOfType('subproblem'),
        ...view.liveOfType('question').filter((q) => q.payload.answeredBy === undefined),
      ];
    case 'synthesizer':
      return view
        .liveOfType('hypothesis')
        .flatMap((h) => [
          h,
          ...view.evidenceSupporting(h.id),
          ...view.evidenceContradicting(h.id),
          ...view.critiquesOf(h.id),
        ]);
    case 'researcher':
    case 'solver':
    case 'critic':
      return [];
  }
};

export const buildAgentView = (
  view: BoardView,
  role: AgentRole,
  targetIds: readonly string[],
  bounds: ViewBounds,
): AgentView => {
  const problem = view.problem();
  const humanNotes = view.liveOfType('human_note');
  const order = new Map(view.entries.map((entry, index) => [entry.id, index]));
  const newestFirst = (a: Entry, b: Entry): number =>
    (order.get(b.id) ?? 0) - (order.get(a.id) ?? 0);
  const shownSeparately = (entry: Entry): boolean => SEPARATE_TYPES.has(entry.type);

  // Targets come from a trigger over the live board, so they are taken as given.
  const targets = targetIds
    .flatMap((id) => {
      const entry = liveEntry(view, id);
      return entry === undefined ? [] : [entry];
    })
    .filter((entry) => !shownSeparately(entry));
  const latest = latestSynthesis(view);
  const related = [
    ...targets.flatMap((target) => neighboursOf(view, target)),
    ...roleExtras(view, role),
    ...(latest === undefined ? [] : [latest]),
    ...view.liveOfType('decision'),
  ]
    .filter((entry) => !shownSeparately(entry))
    .sort(newestFirst);

  const focus: FocusEntry[] = [];
  const inFocus = new Set<string>();
  let focusChars = 0;
  const admit = (entry: Entry, isTarget: boolean): void => {
    if (inFocus.has(entry.id) || focus.length >= bounds.maxFocusEntries) return;
    const clipped = entry.content.length > bounds.maxEntryChars;
    const content = clipped ? entry.content.slice(0, bounds.maxEntryChars) : entry.content;
    // The first entry is always admitted so a misconfigured bound cannot empty the view.
    if (focus.length > 0 && focusChars + content.length > bounds.maxFocusChars) return;
    inFocus.add(entry.id);
    focusChars += content.length;
    focus.push({ entry, content, clipped, isTarget });
  };
  for (const target of targets) admit(target, true);
  for (const entry of related) admit(entry, false);

  // Rolling summary: newest entries get a line each until the budget is spent; from the
  // first entry that does not fit, everything older collapses into per-type tallies.
  const rest = view.live
    .filter((entry) => !shownSeparately(entry) && !inFocus.has(entry.id))
    .sort(newestFirst);
  const summary: string[] = [];
  const digested: Entry[] = [];
  const collapsed: Entry[] = [];
  let summaryChars = 0;
  for (const entry of rest) {
    const line = digestLine(view, entry);
    if (collapsed.length === 0 && summaryChars + line.length <= bounds.maxSummaryChars) {
      summary.push(line);
      digested.push(entry);
      summaryChars += line.length;
    } else {
      collapsed.push(entry);
    }
  }
  const byType = new Map<Entry['type'], Entry[]>();
  for (const entry of collapsed) {
    byType.set(entry.type, [...(byType.get(entry.type) ?? []), entry]);
  }
  const tallied: Entry[] = [];
  for (const [type, entries] of byType) {
    const named = entries.slice(0, TALLY_IDS);
    tallied.push(...named);
    const more = entries.length - named.length;
    summary.push(
      `… ${String(entries.length)} older ${type} ${entries.length === 1 ? 'entry' : 'entries'}: ${named.map((entry) => handleOf(view)(entry.id)).join(', ')}${more > 0 ? ` and ${String(more)} more` : ''}`,
    );
  }

  // Every handle the rendered view will print: the problem and notes, focus entries with
  // all their references, digested entries with their payload references, tallied entries.
  const named = new Set<string>();
  if (problem !== undefined) named.add(problem.id);
  for (const note of humanNotes) named.add(note.id);
  for (const { entry } of focus) {
    named.add(entry.id);
    for (const id of referencedIds(entry)) named.add(id);
  }
  for (const entry of digested) {
    named.add(entry.id);
    for (const id of payloadReferences(entry)) named.add(id);
  }
  for (const entry of tallied) named.add(entry.id);
  const handles = [...named]
    .flatMap((id) => {
      const handle = view.handleOf(id);
      return handle === undefined ? [] : [handle];
    })
    .sort(compareHandles);

  return { problem, humanNotes, focus, summary, omitted: collapsed.length, handles };
};
