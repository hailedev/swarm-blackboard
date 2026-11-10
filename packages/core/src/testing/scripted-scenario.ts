import { openSubproblems } from '../agents/eligibility';
import type { BoardView } from '../board/board-view';
import {
  createFakeModel,
  type FakeModel,
  type FakeResponse,
  type FakeUsage,
} from '../model/fake-model';
import type { Entry } from '../schemas/entry';
import { costOf, type ModelPricing } from '../schemas/pricing';
import type { AgentRole } from '../schemas/role';

// The canonical scripted swarm: a fake model per role that "reads" the board
// through `getView` and answers the way a cooperative model would, by handle, since
// that is what the per-call schema admits. Used by the controller's full-run test and
// by `pnpm solve --fake`.
//
// With the default roster and parallelism 2 it runs four rounds:
//   1 planner → two subproblems
//   2 solver (hypothesis, closes subproblem 1) + researcher (evidence)
//   3 critic (major critique + question) + solver (stronger hypothesis, closes subproblem 2)
//   4 critic (minor critique) + synthesizer (synthesis at 0.9) → completed

export const SCENARIO_TOKENS: FakeUsage = { inputTokens: 1200, outputTokens: 300 };

// A flat, round-number rate card so test arithmetic stays readable: $1 in, $5 out.
export const SCENARIO_PRICING: ModelPricing = {
  tiers: [
    {
      upToPromptTokens: null,
      inputPerMTok: 1,
      outputPerMTok: 5,
      cacheReadPerMTok: 0.1,
      cacheWritePerMTok: 1.25,
    },
  ],
};

/** What one scripted call costs at SCENARIO_PRICING: $0.0027. */
export const SCENARIO_CALL_COST_USD = costOf(
  { ...SCENARIO_TOKENS, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 },
  SCENARIO_PRICING,
);

export type ScenarioPricing = Partial<Record<AgentRole, ModelPricing | null>>;

const respond = (contributions: readonly unknown[]): FakeResponse => ({
  object: { contributions },
  usage: SCENARIO_TOKENS,
});

/** Handles of the given entries, as a model would write them. */
export const handlesOf = (view: BoardView, entries: readonly Entry[]): string[] =>
  entries.flatMap((entry) => {
    const handle = view.handleOf(entry.id);
    return handle === undefined ? [] : [handle];
  });

const handlesOfIds = (view: BoardView, ids: readonly string[]): string[] =>
  ids.flatMap((id) => {
    const handle = view.handleOf(id);
    return handle === undefined ? [] : [handle];
  });

/**
 * Every role is priced at SCENARIO_PRICING unless `pricing` says otherwise; `null`
 * makes a role free, the way a local model is. The CLI passes the resolved profile's
 * pricing so a `--fake` run behaves like the profile it stands in for.
 */
export const createScriptedModels = (
  getView: () => BoardView,
  pricing: ScenarioPricing = {},
): Record<AgentRole, FakeModel> => {
  const priced = (role: AgentRole): ModelPricing | null =>
    role in pricing ? (pricing[role] ?? null) : SCENARIO_PRICING;

  return {
    planner: createFakeModel({
      id: 'fake-planner',
      pricing: priced('planner'),
      script: () => {
        const view = getView();
        const problem = view.problem();
        if (problem === undefined) return respond([]);
        const parents = handlesOf(view, [problem]);
        return respond([
          {
            type: 'subproblem',
            content: 'Map the current pain points and who feels them',
            parents,
            payload: { status: 'open' },
          },
          {
            type: 'subproblem',
            content: 'Estimate migration cost, risk and payback period',
            parents,
            payload: { status: 'open' },
          },
        ]);
      },
    }),

    researcher: createFakeModel({
      id: 'fake-researcher',
      pricing: priced('researcher'),
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
            parents: handlesOf(view, [parent]),
            payload: {
              source: 'internal survey, Q3',
              supports: handlesOf(view, hypotheses),
              contradicts: [],
            },
          },
        ]);
      },
    }),

    solver: createFakeModel({
      id: 'fake-solver',
      pricing: priced('solver'),
      script: () => {
        const view = getView();
        const open = openSubproblems(view);
        const evidence = handlesOf(view, view.liveOfType('evidence'));
        const firstOpen = open[0];
        const current = view.liveOfType('hypothesis')[0];
        const closeFirstOpen =
          firstOpen === undefined
            ? []
            : [
                {
                  type: 'subproblem',
                  content: firstOpen.content,
                  parents: handlesOfIds(view, firstOpen.parents),
                  supersedes: view.handleOf(firstOpen.id),
                  payload: { status: 'done' },
                },
              ];
        if (current === undefined) {
          return respond([
            {
              type: 'hypothesis',
              content: 'Consolidate into a single pnpm monorepo with shared tooling.',
              parents: handlesOf(view, open),
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
            parents: handlesOfIds(view, current.parents),
            supersedes: view.handleOf(current.id),
            payload: { confidence: 0.85, supportedBy: evidence, contradictedBy: [] },
          },
          ...closeFirstOpen,
        ]);
      },
    }),

    critic: createFakeModel({
      id: 'fake-critic',
      pricing: priced('critic'),
      script: () => {
        const view = getView();
        const target = view.liveOfType('hypothesis')[0];
        if (target === undefined) return respond([]);
        const [handle] = handlesOf(view, [target]);
        // Scripts read the board, never their own call count, so a run picked up by a fresh
        // process (controller/rehydrate.ts) continues exactly as an uninterrupted one would.
        if (view.liveOfType('critique').length === 0) {
          return respond([
            {
              type: 'critique',
              content: 'No migration plan: a big-bang move would block every team at once.',
              parents: [handle],
              payload: { target: handle, severity: 'major' },
            },
            {
              type: 'question',
              content: 'Which team is most affected by the current duplication?',
              parents: [handle],
              payload: {},
            },
          ]);
        }
        return respond([
          {
            type: 'critique',
            content: 'Payback period is still an estimate; revisit after the first migration.',
            parents: [handle],
            payload: { target: handle, severity: 'minor' },
          },
        ]);
      },
    }),

    synthesizer: createFakeModel({
      id: 'fake-synthesizer',
      pricing: priced('synthesizer'),
      script: () => {
        const view = getView();
        const cites = handlesOf(view, [
          ...view.liveOfType('hypothesis'),
          ...view.liveOfType('evidence'),
        ]);
        return respond([
          {
            type: 'synthesis',
            // Paragraphs, as the model-facing schema asks; the controller joins them.
            content: [
              'Adopt a single pnpm monorepo, migrating one team per quarter with independent deploys.',
              'Duplicated tooling is the main pain point; the migration cost is a quarter of one engineer.',
            ],
            parents: cites,
            payload: { version: 1, confidence: 0.9, cites },
          },
        ]);
      },
    }),
  };
};
