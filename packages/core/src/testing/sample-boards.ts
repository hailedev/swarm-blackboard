import type { IdGenerator } from '../ports/ids';
import type { EntryOf } from '../schemas/entry';
import { BoardFixture } from './board-fixture';

// Three realistic boards, used for prompt snapshots and the local-model trial: a fresh
// board the Planner decomposes, a mid-run board with a contested hypothesis, and a late
// board with a first synthesis to improve on.

export interface SampleBoard {
  fx: BoardFixture;
  problem: EntryOf<'problem'>;
  /** Live subproblems. */
  subproblems: EntryOf<'subproblem'>[];
  /** Live hypotheses. */
  hypotheses: EntryOf<'hypothesis'>[];
  evidence: EntryOf<'evidence'>[];
  critiques: EntryOf<'critique'>[];
  questions: EntryOf<'question'>[];
  synthesis: EntryOf<'synthesis'> | undefined;
}

const PROBLEM = {
  content:
    'Should our four-person team move its three Node services into one pnpm monorepo, or keep separate repositories?',
  constraints: ['No more than two weeks of migration effort', 'CI must stay under 10 minutes'],
  successCriteria: [
    'A recommendation that names the main risk',
    'Evidence cited for the effort estimate',
  ],
};

export const freshBoard = (ids?: IdGenerator): SampleBoard => {
  const fx = new BoardFixture(ids);
  const problem = fx.entry(
    'problem',
    { constraints: PROBLEM.constraints, successCriteria: PROBLEM.successCriteria },
    { author: 'human', content: PROBLEM.content },
  );
  fx.startRound(1);
  return {
    fx,
    problem,
    subproblems: [],
    hypotheses: [],
    evidence: [],
    critiques: [],
    questions: [],
    synthesis: undefined,
  };
};

export const midRunBoard = (ids?: IdGenerator): SampleBoard => {
  const board = freshBoard(ids);
  const { fx, problem } = board;

  const sub1 = fx.entry(
    'subproblem',
    { status: 'open' },
    {
      author: 'planner',
      parents: [problem.id],
      content:
        'Inventory the shared tooling and dependency drift across the three services and say what duplication costs today.',
    },
  );
  const sub2 = fx.entry(
    'subproblem',
    { status: 'open' },
    {
      author: 'planner',
      parents: [problem.id],
      content:
        'Estimate the migration effort and the CI-time impact of a pnpm workspace against the two-week and ten-minute constraints.',
    },
  );
  const q1 = fx.entry(
    'question',
    {},
    {
      author: 'planner',
      parents: [problem.id],
      content:
        'Which of the three services releases most often, and does it share code with the others?',
    },
  );

  fx.startRound(2);
  const hyp1 = fx.entry(
    'hypothesis',
    { confidence: 0.55, supportedBy: [], contradictedBy: [] },
    {
      author: 'solver',
      parents: [sub1.id, sub2.id],
      content:
        'Consolidate the three services into one pnpm workspace with shared ESLint and TypeScript configuration, migrating one service per sprint. Shared tooling removes the drift, and the migration fits in two weeks if the deploy pipelines stay as they are.',
    },
  );
  const ev1 = fx.entry(
    'evidence',
    { source: 'repository audit, October 2026', supports: [hyp1.id], contradicts: [] },
    {
      author: 'researcher',
      parents: [sub1.id],
      content:
        'Two of the three services pin different TypeScript majors and duplicate 14 ESLint rules; dependency upgrades were applied to all three on separate dates in each of the last four months.',
    },
  );
  const sub1Claimed = fx.entry(
    'subproblem',
    { status: 'claimed' },
    { author: 'solver', parents: sub1.parents, supersedes: sub1.id, content: sub1.content },
  );

  fx.startRound(3);
  const crit1 = fx.entry(
    'critique',
    { target: hyp1.id, severity: 'major' },
    {
      author: 'critic',
      parents: [hyp1.id],
      content:
        'No CI-time estimate: a single workspace that builds and tests all three services on every push may exceed the ten-minute constraint, and the hypothesis does not say how it avoids that.',
    },
  );
  const ev2 = fx.entry(
    'evidence',
    { source: 'general knowledge', supports: [hyp1.id], contradicts: [] },
    {
      author: 'researcher',
      parents: [sub2.id, hyp1.id],
      content:
        'pnpm workspaces with task-level remote caching commonly keep CI under ten minutes for repositories of a few services, because unchanged packages are not rebuilt or retested.',
    },
  );
  fx.entry(
    'human_note',
    { priority: 'high' },
    {
      author: 'human',
      parents: [problem.id],
      content: 'Prefer any option that keeps the three deploy pipelines independent.',
    },
  );
  fx.startRound(4);

  return {
    ...board,
    subproblems: [sub1Claimed, sub2],
    hypotheses: [hyp1],
    evidence: [ev1, ev2],
    critiques: [crit1],
    questions: [q1],
  };
};

export const lateBoard = (ids?: IdGenerator): SampleBoard => {
  const board = midRunBoard(ids);
  const { fx } = board;
  const [sub1Claimed, sub2] = board.subproblems;
  const [hyp1] = board.hypotheses;
  const [ev1, ev2] = board.evidence;
  if (
    sub1Claimed === undefined ||
    sub2 === undefined ||
    hyp1 === undefined ||
    ev1 === undefined ||
    ev2 === undefined
  ) {
    throw new Error('midRunBoard shape changed');
  }

  const hyp2 = fx.entry(
    'hypothesis',
    { confidence: 0.75, supportedBy: [ev1.id, ev2.id], contradictedBy: [] },
    {
      author: 'solver',
      parents: [sub2.id, ev1.id, ev2.id],
      supersedes: hyp1.id,
      content:
        'Consolidate into one pnpm workspace, migrating one service per sprint, but keep the three deploy pipelines separate and add task-level remote caching so CI only rebuilds what changed. This answers the CI-time critique and respects the human note.',
    },
  );
  const sub1Done = fx.entry(
    'subproblem',
    { status: 'done' },
    {
      author: 'solver',
      parents: sub1Claimed.parents,
      supersedes: sub1Claimed.id,
      content: sub1Claimed.content,
    },
  );
  const crit2 = fx.entry(
    'critique',
    { target: hyp2.id, severity: 'minor' },
    {
      author: 'critic',
      parents: [hyp2.id],
      content:
        'The two-week effort figure is asserted, not estimated; a per-service breakdown would make it checkable.',
    },
  );
  const synthesis = fx.entry(
    'synthesis',
    { version: 1, confidence: 0.6, cites: [hyp2.id, ev1.id, ev2.id] },
    {
      author: 'synthesizer',
      parents: [hyp2.id, ev1.id, ev2.id],
      content:
        'Recommendation: move to a single pnpm workspace one service per sprint, keeping the deploy pipelines independent and adding remote caching. Main risk: the effort estimate is unverified. Open: release cadence per service.',
    },
  );
  fx.startRound(5);

  return {
    ...board,
    subproblems: [sub1Done, sub2],
    hypotheses: [hyp2],
    critiques: [...board.critiques, crit2],
    synthesis,
  };
};
