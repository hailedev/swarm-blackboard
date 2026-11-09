import { z } from 'zod';

import { ENTRY_TYPES, type EntryType } from './payloads';

// Short, stable names for board entries as agents see them (docs/PLAN.md §2.2). A handle
// is the entry type's letter plus the entry's ordinal among entries of that type, in commit
// order: the third hypothesis committed is H3 for the life of the run, whatever happens to
// it later. Models reference entries by handle only; UUIDs never reach a prompt or appear
// in a model's output, so a model cannot mangle or invent one.
export const HANDLE_PREFIX: Readonly<Record<EntryType, string>> = {
  problem: 'P',
  subproblem: 'S',
  hypothesis: 'H',
  evidence: 'E',
  critique: 'C',
  question: 'Q',
  decision: 'D',
  synthesis: 'A',
  human_note: 'N',
};

/** The legend agents are shown, in entry-type order. */
export const HANDLE_LEGEND = ENTRY_TYPES.map(
  (type) => `${HANDLE_PREFIX[type]} ${type.replace('_', ' ')}`,
).join(', ');

export const HANDLE_PATTERN = /^[A-Z]\d+$/;
export const HandleSchema = z.string().regex(HANDLE_PATTERN);
export type Handle = z.infer<typeof HandleSchema>;

export const handleFor = (type: EntryType, ordinal: number): Handle =>
  `${HANDLE_PREFIX[type]}${String(ordinal)}`;

/** The entry type a handle's letter stands for; undefined for a letter no type uses. */
export const typeOfHandle = (handle: string): EntryType | undefined =>
  ENTRY_TYPES.find((type) => HANDLE_PREFIX[type] === handle.charAt(0));

const ordinalOf = (handle: string): number => Number(handle.slice(1));

/** Entry-type order first, then ordinal, so a sorted list reads P1, S1, S2, H1, … */
export const compareHandles = (a: Handle, b: Handle): number => {
  const typeA = typeOfHandle(a);
  const typeB = typeOfHandle(b);
  const rankA = typeA === undefined ? ENTRY_TYPES.length : ENTRY_TYPES.indexOf(typeA);
  const rankB = typeB === undefined ? ENTRY_TYPES.length : ENTRY_TYPES.indexOf(typeB);
  return rankA - rankB || ordinalOf(a) - ordinalOf(b);
};
