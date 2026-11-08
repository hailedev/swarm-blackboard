import type { AgentRole } from '../agents/agent';
import { openSubproblems } from '../agents/eligibility';
import type { BoardView } from '../board/board-view';
import { createFakeModel, type FakeModel, type FakeResponse } from '../model/fake-model';
import type { Usage } from '../schemas/common';
import type { Entry } from '../schemas/entry';

// The canonical scripted swarm: a fake model per role that "reads" the board
// through `getView` and answers the way a cooperative model would. Used by the
// controller's full-run test and by `pnpm solve --fake`.
//
// With the default roster and parallelism 2 it runs four rounds:
//   1 planner → two subproblems
//   2 solver (hypothesis, closes subproblem 1) + researcher (evidence)
//   3 critic (major critique + question) + solver (stronger hypothesis, closes subproblem 2)
//   4 critic (minor critique) + synthesizer (synthesis at 0.9) → synthesis_confident

export const SCENARIO_USAGE: Usage = { inputTokens: 1200, outputTokens: 300, costUsd: 0.0045 };

const respond = (contributions: readonly unknown[]): FakeResponse => ({
  object: { contributions },
  usage: SCENARIO_USAGE,
});

const ids = (entries: readonly Entry[]): string[] => entries.map((e) => e.id);

export const createScriptedModels = (getView: () => BoardView): Record<AgentRole, FakeModel> => ({
  planner: createFakeModel({
    id: 'fake-planner',
    script: () => {
      const problem = getView().problem();
      if (problem === undefined) return respond([]);
      return respond([
        {
          type: 'subproblem',
          content: 'Map the current pain points and who feels them',
          parents: [problem.id],
          payload: { status: 'open' },
        },
        {
          type: 'subproblem',
          content: 'Estimate migration cost, risk and payback period',
          parents: [problem.id],
          payload: { status: 'open' },
        },
      ]);
    },
  }),

  researcher: createFakeModel({
    id: 'fake-researcher',
    script: () => {
      const view = getView();
      const open = openSubproblems(view);
      const hypotheses = view.liveOfType('hypothesis');
      const parent = open[0] ?? hypotheses[0] ?? view.problem();
      if (parent === undefined) return respond([]);
      return respond([
        {
          type: 'evidence',
          content:
            'Three of four teams report duplicated build tooling and drifting dependency versions.',
          parents: [parent.id],
          payload: { source: 'internal survey, Q3', supports: ids(hypotheses), contradicts: [] },
        },
      ]);
    },
  }),

  solver: createFakeModel({
    id: 'fake-solver',
    script: (_request, index) => {
      const view = getView();
      const open = openSubproblems(view);
      const evidence = ids(view.liveOfType('evidence'));
      const firstOpen = open[0];
      const current = view.liveOfType('hypothesis')[0];
      const closeFirstOpen =
        firstOpen === undefined
          ? []
          : [
              {
                type: 'subproblem',
                content: firstOpen.content,
                parents: firstOpen.parents,
                supersedes: firstOpen.id,
                payload: { status: 'done' },
              },
            ];
      if (index === 0 || current === undefined) {
        return respond([
          {
            type: 'hypothesis',
            content: 'Consolidate into a single pnpm monorepo with shared tooling.',
            parents: ids(open),
            payload: { confidence: 0.6, supportedBy: evidence, contradictedBy: [] },
          },
          ...closeFirstOpen,
        ]);
      }
      return respond([
        {
          type: 'hypothesis',
          content:
            'Consolidate into a single pnpm monorepo, migrating one team per quarter and keeping deploys independent.',
          parents: current.parents,
          supersedes: current.id,
          payload: { confidence: 0.85, supportedBy: evidence, contradictedBy: [] },
        },
        ...closeFirstOpen,
      ]);
    },
  }),

  critic: createFakeModel({
    id: 'fake-critic',
    script: (_request, index) => {
      const target = getView().liveOfType('hypothesis')[0];
      if (target === undefined) return respond([]);
      if (index === 0) {
        return respond([
          {
            type: 'critique',
            content: 'No migration plan: a big-bang move would block every team at once.',
            parents: [target.id],
            payload: { target: target.id, severity: 'major' },
          },
          {
            type: 'question',
            content: 'Which team is most affected by the current duplication?',
            parents: [target.id],
            payload: {},
          },
        ]);
      }
      return respond([
        {
          type: 'critique',
          content: 'Payback period is still an estimate; revisit after the first migration.',
          parents: [target.id],
          payload: { target: target.id, severity: 'minor' },
        },
      ]);
    },
  }),

  synthesizer: createFakeModel({
    id: 'fake-synthesizer',
    script: () => {
      const view = getView();
      const cites = [...ids(view.liveOfType('hypothesis')), ...ids(view.liveOfType('evidence'))];
      return respond([
        {
          type: 'synthesis',
          content:
            'Adopt a single pnpm monorepo, migrating one team per quarter with independent deploys; duplicated tooling is the main pain point.',
          parents: cites,
          payload: { version: 1, confidence: 0.9, cites },
        },
      ]);
    },
  }),
});
