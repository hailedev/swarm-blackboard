import { openSubproblems } from '../agents/eligibility';
import { WRITE_UP_ROLE } from '../agents/write-up';
import type { BoardView } from '../board/board-view';
import { newVersionOf } from '../schemas/contribution';
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
//   2 solver (a hypothesis parented on both, which answers them) + researcher (evidence)
//   3 critic (major critique + question) + solver (a stronger version that supersedes it)
//   4 critic (reviews the new version: a question, no critique) + synthesizer (synthesis
//     at 0.9) → completed: nothing is open, the Critic has seen the standing version, and
//     the synthesis was written after the last hypothesis and critique landed
// Ten entries: the problem, two subproblems, two hypotheses, one evidence, one critique,
// two questions and the synthesis.
// and, when the controller is given the Synthesizer's model for the final write-up, one
// more call after the last round: the answer written from the whole board.

export const SCENARIO_TOKENS: FakeUsage = { inputTokens: 1200, outputTokens: 300 };

// The scripted final answer, written out at the length a write-up is asked for: about 750
// words, more than half of the default budget (900) and of the eval's (1,350), so the
// length guard (agents/word-budget.ts) has nothing to ask for on the canonical run.
export const SCRIPTED_ANSWER: readonly string[] = [
  'Adopt a single pnpm monorepo, migrating one team per quarter and keeping deploys independent.',
  'Duplicated build tooling and drifting dependency versions are the main cost today; one repository with shared tooling removes both, for about a quarter of one engineer during the migration.',
  'Quarter one moves the platform team, because it owns the build scripts everyone else copies. Its repository is imported with full history, its lint, test and build configuration become the shared presets, and its pipeline is rewritten to build only what a change touches. The work is budgeted at twelve engineer-days spread over the quarter, with one engineer as owner and a second reviewing. The quarter ends with a written checklist for the teams that follow and a measured baseline: build time, time to a green pipeline and the number of dependency versions in use.',
  'Quarter two moves the payments team, the one with the most duplicated tooling and so the most to gain. It follows the checklist, deletes its copies of the shared presets and keeps its own deploy pipeline and release calendar. Budget ten engineer-days. Two checks decide whether the migration continues: the pipeline for a typical change must finish within ten minutes, and no payments release may be delayed by a change that belongs to another team. If either fails, the third team waits until it is fixed.',
  'Quarters three and four move the two remaining teams in order of release frequency, the busier one last so that it inherits the most settled setup. Each is budgeted at eight engineer-days, less than the first two because the presets and the checklist exist by then. During these quarters dependency upgrades are done once for the whole repository, on the first Tuesday of the month, by whoever is on the tooling rota, and a version that breaks one team is pinned for that team for at most thirty days.',
  'Deploys stay independent throughout. Every team keeps its own pipeline, its own release schedule and its own rollback, and a change is built, tested and shipped only for the packages it touches. Ownership is explicit: each directory has named owners whose review is required, and a change that crosses a team boundary needs a review from both sides. This is the main protection against the usual complaint about a shared repository, that one team in a hurry becomes an outage for every team.',
  'The costs are small and mostly up front. The migration takes about thirty-eight engineer-days over the year, a little under a quarter of one engineer, and remote caching for the shared pipeline costs about forty dollars a month. Against that, each team now spends roughly two days a quarter keeping its own copy of the tooling alive and another day chasing version drift, about forty-eight engineer-days a year across four teams, so the move pays for itself within the first year if the estimates hold.',
  'Three risks deserve a named response. Pipeline time creeping up as the repository grows: watched monthly against the ten-minute limit, with caching and affected-only builds as the remedy. A big-bang cut-over that blocks everyone: ruled out by moving one team a quarter, each of them able to stay where it is for another quarter. Loss of autonomy: answered by the ownership rules and the separate release calendars. If two of the three checks fail after the second team, the remaining teams stay in their own repositories and share only the presets, published as a package.',
  'Success is measured the same way each quarter: the number of distinct versions of the ten most used dependencies, which should fall from fourteen to ten after the first team and to no more than three at the end; the median time from push to a green pipeline; and the hours each team reports spending on tooling. The figures are reviewed at the end of every quarter by the four team leads, and the decision to move the next team is taken in that review, not before.',
  'Nothing in this plan depends on a tool the teams do not already use. The package manager, the test runner and the pipelines stay the same; what changes is where the code lives and who maintains the configuration. That keeps the first quarter reversible: until the second team moves, the platform team can return to its own repository in a day by restoring its old pipeline file.',
  'Assumption: the payback period holds as estimated. Check it once the first team has moved, before the second starts.',
];

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
        const current = view.liveOfType('hypothesis')[0];
        // A hypothesis answers one subproblem by name and any other it lists as a parent
        // that has no answer yet; nobody posts a status.
        if (current === undefined) {
          const [first] = handlesOf(view, open);
          return respond([
            {
              type: 'hypothesis',
              ...(first === undefined ? {} : { answers: first }),
              content: 'Consolidate into a single pnpm monorepo with shared tooling.',
              parents: handlesOf(view, open),
              payload: { confidence: 0.6, supportedBy: evidence, contradictedBy: [] },
            },
          ]);
        }
        // The stronger version replaces the standing answer to the same subproblem.
        const [answered] = handlesOf(
          view,
          view.liveOfType('subproblem').filter((s) => current.parents.includes(s.id)),
        );
        const standing = view.handleOf(current.id);
        return respond([
          {
            type: 'hypothesis',
            ...(answered === undefined || standing === undefined
              ? { supersedes: standing }
              : { answers: answered, relation: newVersionOf(standing) }),
            content:
              'Consolidate into a single pnpm monorepo, migrating one team per quarter and keeping deploys independent.',
            parents: handlesOfIds(view, current.parents),
            payload: { confidence: 0.85, supportedBy: evidence, contradictedBy: [] },
          },
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
        // Reviewing the stronger version it finds nothing to object to, only something to
        // ask. A run may end on a synthesis only when no critique landed beside it
        // (controller/termination.ts), and this is the round the scripted run ends in.
        return respond([
          {
            type: 'question',
            content: 'Is the payback period still an estimate once the first team has migrated?',
            parents: [handle],
            payload: {},
          },
        ]);
      },
    }),

    synthesizer: createFakeModel({
      id: 'fake-synthesizer',
      pricing: priced('synthesizer'),
      script: (request) => {
        const view = getView();
        const cites = handlesOf(view, [
          ...view.liveOfType('hypothesis'),
          ...view.liveOfType('evidence'),
        ]);
        // The final write-up is the Synthesizer's model under another role tag and another
        // schema (agents/write-up.ts). The answer is valid on any board the controller
        // writes up: with no hypothesis yet it cites the subproblems, or the problem.
        if (request.tags.role === WRITE_UP_ROLE) {
          const thin = handlesOf(view, [...view.liveOfType('subproblem')]);
          const problem = view.problem();
          const fallback =
            thin.length > 0 || problem === undefined ? thin : handlesOf(view, [problem]);
          return {
            object:
              cites.length > 0
                ? {
                    paragraphs: SCRIPTED_ANSWER,
                    confidence: 0.9,
                    cites,
                  }
                : {
                    paragraphs: [
                      'No recommendation can be made yet: the work stopped before a candidate answer was reached.',
                      'Assumption: the open subproblems are the right first steps. Settle them before choosing.',
                    ],
                    confidence: 0.2,
                    cites: fallback,
                  },
            usage: SCENARIO_TOKENS,
          };
        }
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
