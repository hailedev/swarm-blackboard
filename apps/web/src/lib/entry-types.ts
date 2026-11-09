import type { EntryType } from '@team/core';

// The board's lanes, left to right: the question, what the user added, the decomposition,
// the argument, and the answer. Type is carried by the lane and by the handle's letter,
// never by colour.
export const LANES: readonly EntryType[] = [
  'problem',
  'human_note',
  'subproblem',
  'hypothesis',
  'evidence',
  'critique',
  'question',
  'decision',
  'synthesis',
];

export const LANE_LABEL: Record<EntryType, string> = {
  problem: 'Problem',
  human_note: 'Your notes',
  subproblem: 'Subproblems',
  hypothesis: 'Hypotheses',
  evidence: 'Evidence',
  critique: 'Critiques',
  question: 'Questions',
  decision: 'Decisions',
  synthesis: 'Synthesis',
};

export const TYPE_LABEL: Record<EntryType, string> = {
  problem: 'problem',
  human_note: 'note',
  subproblem: 'subproblem',
  hypothesis: 'hypothesis',
  evidence: 'evidence',
  critique: 'critique',
  question: 'question',
  decision: 'decision',
  synthesis: 'synthesis',
};
