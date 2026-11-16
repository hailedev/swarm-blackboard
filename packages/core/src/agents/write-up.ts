import { z, type ZodType } from 'zod';

import type { BoardView } from '../board/board-view';
import { err, ok, type Result } from '../ports/result';
import { ConfidenceSchema } from '../schemas/common';
import type { ContributionOf } from '../schemas/contribution';
import type { Entry, EntryOf } from '../schemas/entry';
import { compareHandles, HANDLE_LEGEND, type Handle } from '../schemas/handle';
import type { CritiqueSeverity } from '../schemas/payloads';
import type { WriteUpConfig } from '../schemas/run-config';
import { digestLine, handleOf, payloadDigest, payloadReferences } from './agent-view';
import { latestSynthesis } from './eligibility';
import { PARAGRAPH_SEPARATOR } from './handles';
import { lengthInstruction } from './word-budget';

// The final write-up (docs/PLAN.md §2.3 step 8). When a run ends, the Synthesizer's model
// writes the answer once more, and this time it reads the whole live board rather than the
// bounded view an agent gets in a round: every live entry in full, by handle, up to
// `maxBoardChars`. This module lays that prompt out and says what the model returns; the
// controller makes the call, stamps the entry and commits it (controller/write-up.ts). It
// is a pure function of the board, so the prompt can be snapshot-tested like an agent's.

/** The role the write-up call is traced under. */
export const WRITE_UP_ROLE = 'write-up';
/** Who the final synthesis is by on the board: the role whose model wrote it. */
export const WRITE_UP_AUTHOR = 'synthesizer';

/** What the model returns: the text, how sure it is, and the entries the text rests on. */
export interface WriteUpOutput {
  paragraphs: string[];
  confidence: number;
  cites: string[];
}

/**
 * The answer as paragraphs (the shape every long-form answer has, ADR-0008) and its
 * provenance as handles the prompt named. Version, `supersedes` and the stage are not the
 * model's to state: the controller stamps them.
 */
export const writeUpOutputSchema = (citeable: readonly Handle[]): ZodType<WriteUpOutput> =>
  z.object({
    paragraphs: z.array(z.string().min(1)).min(1),
    confidence: ConfidenceSchema,
    cites: z.array(z.enum([...citeable])).min(1),
  });

export interface RenderedWriteUp {
  prompt: string;
  /** Every entry the prompt shows, by type then ordinal. */
  handles: readonly Handle[];
  /**
   * What the answer may cite: the entries shown and the ones their links name, earlier
   * syntheses excepted (the final answer supersedes the draft; it does not rest on it).
   */
  citeable: readonly Handle[];
  /** Live entries shown in full, as one line for want of room, and not at all. */
  shown: { full: number; digested: number; omitted: number };
  /** Critiques left out: resolved, or attacking an entry that has since been replaced. */
  staleCritiques: number;
}

const SEVERITY_ORDER: Readonly<Record<CritiqueSeverity, number>> = {
  blocking: 0,
  major: 1,
  minor: 2,
};

/** A critique that still stands: unresolved, against an entry that is still live. */
const stands = (view: BoardView, critique: EntryOf<'critique'>): boolean =>
  critique.payload.resolvedBy === undefined && view.isLive(critique.payload.target);

const bySeverity = (a: EntryOf<'critique'>, b: EntryOf<'critique'>): number =>
  SEVERITY_ORDER[a.payload.severity] - SEVERITY_ORDER[b.payload.severity];

// One entry of the layout. A `block` gets a heading of its own (a decision, a candidate
// answer, the draft); a `bullet` is a list item, nested under the hypothesis it belongs to
// or listed in its section. `note` says what a nested entry is to its hypothesis.
interface Item {
  entry: Entry;
  kind: 'block' | 'bullet';
  note: string | null;
}

interface Section {
  title: string;
  items: Item[];
  /** Lines that follow an item whatever becomes of it: references to entries shown above. */
  trailers: Map<string, string[]>;
}

const header = (view: BoardView, item: Item): string => {
  const { entry } = item;
  return `${handleOf(view)(entry.id)} (${entry.type}, round ${String(entry.round)}${item.note === null ? '' : `; ${item.note}`}): ${payloadDigest(view, entry)}`;
};

const fullLines = (view: BoardView, item: Item): string[] =>
  item.kind === 'block'
    ? [`### ${header(view, item)}`, item.entry.content, '']
    : [`- ${header(view, item)}`, `  ${item.entry.content.replace(/\n/g, '\n  ')}`];

const sizeOf = (lines: readonly string[]): number =>
  lines.reduce((total, line) => total + line.length + 1, 0);

// The board as sections, in the order the writer needs it: what was decided, the candidate
// answers with what supports and what attacks each, then everything else.
const sectionsOf = (view: BoardView): { sections: Section[]; staleCritiques: number } => {
  const h = handleOf(view);
  const placed = new Set<string>();
  const section = (title: string): Section => ({ title, items: [], trailers: new Map() });
  const place = (into: Section, entry: Entry, kind: Item['kind'], note: string | null): void => {
    placed.add(entry.id);
    into.items.push({ entry, kind, note });
  };

  const decisions = section('Decisions');
  for (const decision of view.liveOfType('decision')) place(decisions, decision, 'block', null);

  // Most confident first; among equals the newer one, which usually refines the older.
  const candidates = section('Candidate answers, most confident first');
  const hypotheses = [...view.liveOfType('hypothesis')]
    .map((hypothesis, index) => ({ hypothesis, index }))
    .sort(
      (a, b) =>
        b.hypothesis.payload.confidence - a.hypothesis.payload.confidence || b.index - a.index,
    )
    .map(({ hypothesis }) => hypothesis);
  for (const hypothesis of hypotheses) {
    place(candidates, hypothesis, 'block', null);
    const trailer: string[] = [];
    const attach = (evidence: readonly EntryOf<'evidence'>[], note: string): void => {
      const above = evidence.filter((e) => placed.has(e.id));
      if (above.length > 0) {
        trailer.push(`  (${note}, shown above: ${above.map((e) => h(e.id)).join(', ')})`);
      }
      for (const e of evidence) if (!placed.has(e.id)) place(candidates, e, 'bullet', note);
    };
    attach(view.evidenceSupporting(hypothesis.id), 'supports it');
    attach(view.evidenceContradicting(hypothesis.id), 'contradicts it');
    const critiques = view
      .critiquesOf(hypothesis.id)
      .filter((c) => stands(view, c))
      .sort(bySeverity);
    for (const critique of critiques) place(candidates, critique, 'bullet', 'critique that stands');
    const last = candidates.items.at(-1);
    if (trailer.length > 0 && last !== undefined) candidates.trailers.set(last.entry.id, trailer);
  }

  const evidence = section('Other evidence');
  for (const e of view.liveOfType('evidence')) {
    if (!placed.has(e.id)) place(evidence, e, 'bullet', null);
  }

  // Critiques of anything but a hypothesis: evidence, a subproblem, the draft itself.
  const critiques = section('Other critiques that stand');
  let staleCritiques = 0;
  for (const critique of [...view.liveOfType('critique')].sort(bySeverity)) {
    if (placed.has(critique.id)) continue;
    if (stands(view, critique)) place(critiques, critique, 'bullet', null);
    else staleCritiques += 1;
  }

  const questions = section('Open questions');
  for (const question of view.liveOfType('question')) {
    if (question.payload.answeredBy === undefined) place(questions, question, 'bullet', null);
  }

  const subproblems = section('Subproblems');
  for (const subproblem of view.liveOfType('subproblem')) {
    place(subproblems, subproblem, 'bullet', null);
  }

  const draft = section('Latest draft of the answer');
  const latest = latestSynthesis(view);
  if (latest !== undefined) place(draft, latest, 'block', null);

  return {
    sections: [decisions, candidates, evidence, critiques, questions, subproblems, draft],
    staleCritiques,
  };
};

/**
 * The prompt the write-up is written from. The problem and the human notes are always shown
 * in full; the rest of the live board follows within `maxBoardChars`, each entry in full
 * while there is room, then as one digest line, then not at all (and the prompt says how
 * many). `wordBudget` is stated in the sentence the eval baseline reads (word-budget.ts).
 */
export const renderWriteUpPrompt = (
  view: BoardView,
  bounds: Pick<WriteUpConfig, 'maxBoardChars'>,
  wordBudget: number,
): RenderedWriteUp => {
  const h = handleOf(view);
  const named = new Set<Handle>();
  const linked = new Set<Handle>();
  const name = (entry: Entry): void => {
    const handle = view.handleOf(entry.id);
    if (handle !== undefined) named.add(handle);
    for (const id of payloadReferences(entry)) {
      const reference = view.handleOf(id);
      if (reference !== undefined) linked.add(reference);
    }
  };

  const lines: string[] = [];
  const problem = view.problem();
  if (problem === undefined) {
    lines.push('# Problem', '(no problem entry on the board)');
  } else {
    name(problem);
    lines.push(`# Problem (${h(problem.id)})`, problem.content);
    if (problem.payload.constraints.length > 0) {
      lines.push('', 'Constraints:', ...problem.payload.constraints.map((c) => `- ${c}`));
    }
    if (problem.payload.successCriteria.length > 0) {
      lines.push(
        '',
        'Success criteria:',
        ...problem.payload.successCriteria.map((c, i) => `${String(i + 1)}. ${c}`),
      );
    }
  }

  const notes = view.liveOfType('human_note');
  if (notes.length > 0) {
    lines.push('', '# Human notes');
    for (const note of notes) {
      name(note);
      lines.push(`- ${h(note.id)} (priority ${note.payload.priority}): ${note.content}`);
    }
  }

  const { sections, staleCritiques } = sectionsOf(view);
  const shown = { full: 0, digested: 0, omitted: 0 };
  let used = 0;
  lines.push('', '# The board');
  for (const section of sections) {
    if (section.items.length === 0) continue;
    const body: string[] = [];
    for (const item of section.items) {
      const full = fullLines(view, item);
      const digest = [`- ${digestLine(view, item.entry)}`];
      if (used + sizeOf(full) <= bounds.maxBoardChars) {
        body.push(...full);
        used += sizeOf(full);
        shown.full += 1;
        name(item.entry);
      } else if (used + sizeOf(digest) <= bounds.maxBoardChars) {
        body.push(...digest);
        used += sizeOf(digest);
        shown.digested += 1;
        name(item.entry);
      } else {
        shown.omitted += 1;
      }
      body.push(...(section.trailers.get(item.entry.id) ?? []));
    }
    // A block ends on a blank line; the next heading brings its own.
    while (body.at(-1) === '') body.pop();
    if (body.length > 0) lines.push('', `## ${section.title}`, ...body);
  }
  if (shown.full + shown.digested === 0) lines.push('(nothing but the problem)');

  const left: string[] = [];
  if (shown.omitted > 0) {
    left.push(
      `${String(shown.omitted)} more live ${shown.omitted === 1 ? 'entry is' : 'entries are'} not shown for want of room`,
    );
  }
  if (staleCritiques > 0) {
    left.push(
      `${String(staleCritiques)} ${staleCritiques === 1 ? 'critique is' : 'critiques are'} left out because ${staleCritiques === 1 ? 'it was' : 'they were'} resolved or what ${staleCritiques === 1 ? 'it attacks' : 'they attack'} has been replaced`,
    );
  }
  if (left.length > 0) lines.push('', `Not shown: ${left.join('; ')}.`);

  const handles = [...named].sort(compareHandles);
  const citeable = [...new Set([...named, ...linked])]
    .filter((handle) => view.byHandle(handle)?.type !== 'synthesis')
    .sort(compareHandles);

  lines.push(
    '',
    '# What to return',
    lengthInstruction(wordBudget),
    '',
    `Return JSON matching the schema. \`cites\` are the handles (${HANDLE_LEGEND}) of the entries above that the answer rests on, copied exactly. Handles belong in \`cites\` only: the text of the answer must not contain one.`,
  );
  return { prompt: lines.join('\n'), handles, citeable, shown, staleCritiques };
};

/** A write-up with its cited handles mapped back to entry ids, each once. */
export interface ResolvedWriteUp {
  paragraphs: readonly string[];
  confidence: number;
  citeIds: readonly string[];
}

/** Zod-style `path: message` issues, so they can feed the repair prompt directly. */
export const resolveWriteUp = (
  output: WriteUpOutput,
  view: BoardView,
): Result<ResolvedWriteUp, string[]> => {
  const issues: string[] = [];
  const citeIds: string[] = [];
  output.cites.forEach((handle, index) => {
    const entry = view.byHandle(handle);
    if (entry === undefined) {
      issues.push(`cites.${String(index)}: unknown handle "${handle}"`);
    } else if (!citeIds.includes(entry.id)) {
      citeIds.push(entry.id);
    }
  });
  if (issues.length > 0) return err(issues);
  return ok({ paragraphs: output.paragraphs, confidence: output.confidence, citeIds });
};

/**
 * The write-up as the synthesis the controller commits: one version past the latest live
 * synthesis and superseding it, so every reader of "the run's answer" (`latestSynthesis`)
 * finds the write-up; its parents are what it cites, as an agent's synthesis has them. The
 * stage is stamped at commit (`prepareEntries`), not here: a contribution has none.
 */
export const writeUpContribution = (
  view: BoardView,
  resolved: ResolvedWriteUp,
): ContributionOf<'synthesis'> => {
  const latest = latestSynthesis(view);
  return {
    type: 'synthesis',
    content: resolved.paragraphs.join(PARAGRAPH_SEPARATOR),
    parents: [...resolved.citeIds],
    ...(latest === undefined ? {} : { supersedes: latest.id }),
    payload: {
      version: (latest?.payload.version ?? 0) + 1,
      confidence: resolved.confidence,
      cites: [...resolved.citeIds],
    },
  };
};
