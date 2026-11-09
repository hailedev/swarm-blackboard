import { referencedIds, type BoardView, type Entry } from '@team/core';

// How entries hang together: the links the board draws and the provenance chain the
// detail view lists. Everything is derived from the entries' own fields.

export type LinkKind =
  | 'parent'
  | 'supersedes'
  | 'supports'
  | 'contradicts'
  | 'critiques'
  | 'resolves'
  | 'answers'
  | 'chooses'
  | 'rejects'
  | 'cites';

/** How a link is drawn: agreement solid, disagreement dashed, replacement dotted. */
export type LinkStyle = 'solid' | 'dashed' | 'dotted';

export const LINK_STYLE: Record<LinkKind, LinkStyle> = {
  parent: 'solid',
  supports: 'solid',
  resolves: 'solid',
  answers: 'solid',
  chooses: 'solid',
  cites: 'solid',
  contradicts: 'dashed',
  critiques: 'dashed',
  rejects: 'dashed',
  supersedes: 'dotted',
};

export const LINK_LABEL: Record<LinkKind, string> = {
  parent: 'builds on',
  supersedes: 'supersedes',
  supports: 'supports',
  contradicts: 'contradicts',
  critiques: 'critiques',
  resolves: 'resolved by',
  answers: 'answered by',
  chooses: 'chooses',
  rejects: 'rejects',
  cites: 'cites',
};

export interface Link {
  /** The entry that names the other. */
  from: string;
  to: string;
  kind: LinkKind;
}

const typed = (from: string, kind: LinkKind, ids: readonly string[]): Link[] =>
  ids.map((to) => ({ from, to, kind }));

/** What an entry's payload says about other entries, by kind. */
const payloadLinks = (entry: Entry): Link[] => {
  switch (entry.type) {
    case 'hypothesis':
      // The hypothesis names its evidence; the link reads from the evidence's side.
      return [
        ...entry.payload.supportedBy.map((id): Link => ({
          from: id,
          to: entry.id,
          kind: 'supports',
        })),
        ...entry.payload.contradictedBy.map((id): Link => ({
          from: id,
          to: entry.id,
          kind: 'contradicts',
        })),
      ];
    case 'evidence':
      return [
        ...typed(entry.id, 'supports', entry.payload.supports),
        ...typed(entry.id, 'contradicts', entry.payload.contradicts),
      ];
    case 'critique':
      return [
        ...typed(entry.id, 'critiques', [entry.payload.target]),
        ...typed(
          entry.id,
          'resolves',
          entry.payload.resolvedBy === undefined ? [] : [entry.payload.resolvedBy],
        ),
      ];
    case 'question':
      return typed(
        entry.id,
        'answers',
        entry.payload.answeredBy === undefined ? [] : [entry.payload.answeredBy],
      );
    case 'decision':
      return [
        ...typed(entry.id, 'chooses', [entry.payload.chosen]),
        ...typed(entry.id, 'rejects', entry.payload.rejected),
      ];
    case 'synthesis':
      return typed(entry.id, 'cites', entry.payload.cites);
    case 'problem':
    case 'subproblem':
    case 'human_note':
      return [];
  }
};

/**
 * Every link an entry makes, one per pair of entries: a payload link says more than
 * `parents` does, so where both name the same entry the payload's kind is kept.
 */
export const linksOf = (entry: Entry): Link[] => {
  const links = [
    ...payloadLinks(entry),
    ...typed(entry.id, 'supersedes', entry.supersedes === undefined ? [] : [entry.supersedes]),
    ...typed(entry.id, 'parent', entry.parents),
  ];
  const seen = new Set<string>();
  return links.filter((link) => {
    const key = [link.from, link.to].sort().join('|');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

/** All links between entries on the board; a link to an entry the board lacks is dropped. */
export const boardLinks = (view: BoardView): Link[] => {
  const seen = new Set<string>();
  return view.entries
    .flatMap(linksOf)
    .filter((link) => view.byId(link.from) !== undefined && view.byId(link.to) !== undefined)
    .filter((link) => {
      const key = [link.from, link.to].sort().join('|');
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
};

/** The links that touch `entryId`, from either end. */
export const linksTouching = (links: readonly Link[], entryId: string): Link[] =>
  links.filter((link) => link.from === entryId || link.to === entryId);

/** The ids at the other end of every link touching `entryId`. */
export const neighbourIds = (links: readonly Link[], entryId: string): Set<string> =>
  new Set(
    linksTouching(links, entryId).map((link) => (link.from === entryId ? link.to : link.from)),
  );

export interface Ancestor {
  entry: Entry;
  /** 1 for what the entry names directly, 2 for what those name, and so on. */
  depth: number;
}

/**
 * The provenance chain: everything an entry rests on, nearest first, back to the problem.
 * Each entry appears once, at the smallest depth it is reached at.
 */
export const ancestorsOf = (view: BoardView, entryId: string): Ancestor[] => {
  const start = view.byId(entryId);
  if (start === undefined) return [];
  const out: Ancestor[] = [];
  const seen = new Set<string>([entryId]);
  let frontier: Entry[] = [start];
  for (let depth = 1; frontier.length > 0; depth += 1) {
    const next: Entry[] = [];
    for (const entry of frontier) {
      for (const id of referencedIds(entry)) {
        if (seen.has(id)) continue;
        seen.add(id);
        const found = view.byId(id);
        if (found === undefined) continue;
        out.push({ entry: found, depth });
        next.push(found);
      }
    }
    frontier = next;
  }
  return out;
};

/** Entries that name `entryId` in their parents, their payload or as what they supersede. */
export const referrersOf = (view: BoardView, entryId: string): Entry[] =>
  view.entries.filter((entry) => entry.id !== entryId && referencedIds(entry).includes(entryId));
