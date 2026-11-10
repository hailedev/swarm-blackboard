import {
  estimateInput,
  fitCall,
  type Model,
  type Result,
  type RunEndReason,
  type RunStatus,
  type Usage,
} from '@team/core';

import {
  baselineCacheKey,
  describeBaselineError,
  generateBaseline,
  type BaselineCache,
  type BaselineRecord,
} from './baseline';
import {
  blindOrder,
  blindText,
  JUDGE_SYSTEM,
  judgePrompt,
  judgementSchema,
  swapped,
  unblind,
  type BlindOrder,
  type UnblindedJudgement,
} from './judge';
import type { Problem } from './problems';
import { aggregate, scoreProblem, type Aggregate, type ProblemScores } from './scoring';

// One eval pass (ADR-0012): for each problem, in order, the swarm run, the baseline call
// and the blind judgements. The pass has its own dollar cap, enforced here in code like
// every other budget (CLAUDE.md rule 4): a call that cannot fit what is left is skipped
// with a reason, and the pass stops cleanly, with a partial report, when nothing more fits.
// Everything that touches the outside world comes in through `PassDeps`.

export interface SwarmOutcome {
  runId: string;
  /** The latest synthesis's content, or null when the run ended without one. */
  answer: string | null;
  confidence: number | null;
  rounds: number;
  status: RunStatus;
  reason: RunEndReason;
  entries: number;
  usage: Usage;
  costUsd: number;
  elapsedMs: number;
}

export interface MonthGuard {
  spentUsd(): Promise<number>;
  limitUsd: number;
}

export interface PassDeps {
  /** Runs the swarm on a problem under a cost cap; the controller enforces the cap. */
  runSwarm(problem: Problem, maxCostUsd: number): Promise<Result<SwarmOutcome, string>>;
  baselineModel: Model;
  judgeModel: Model;
  cache: BaselineCache;
  /** Present when any model is paid: the pass re-reads the month before each problem. */
  month: MonthGuard | null;
  now(): number;
  log(line: string): void;
  rng(): number;
}

export interface PassOptions {
  passId: string;
  problems: readonly Problem[];
  /** Hard cap on what the whole pass may spend. */
  capUsd: number;
  /** Cap on each swarm run; the run gets the smaller of this and what the pass has left. */
  runCapUsd: number;
  /** 2 judges each pair in both orders; 1 judges it once, in a random order. */
  judgeOrders: 1 | 2;
  refreshBaselines: boolean;
  baselineMaxOutputTokens: number;
  judgeMaxOutputTokens: number;
}

export interface ProblemResult {
  problem: Problem;
  swarm: SwarmOutcome | null;
  swarmError: string | null;
  baseline: BaselineRecord | null;
  baselineCached: boolean;
  baselineSkipped: string | null;
  judgements: UnblindedJudgement[];
  judgeSkipped: string[];
  scores: ProblemScores;
  /** What this problem cost the pass: the swarm run plus any uncached baseline and judge calls. */
  costUsd: number;
}

export type PassStop =
  | { reason: 'pass_cap'; beforeProblem: string; remainingUsd: number }
  | { reason: 'monthly_budget'; beforeProblem: string; spentUsd: number; limitUsd: number };

export interface PassResult {
  passId: string;
  startedAt: string;
  endedAt: string;
  options: Omit<PassOptions, 'problems'> & { problemIds: string[] };
  results: ProblemResult[];
  spentUsd: number;
  stopped: PassStop | null;
  aggregate: Aggregate;
}

/** The pass cap as a ledger: sequential calls, each charged after it returns. */
export class PassBudget {
  readonly capUsd: number;
  #spentUsd = 0;

  constructor(capUsd: number) {
    this.capUsd = capUsd;
  }

  get spentUsd(): number {
    return this.#spentUsd;
  }

  get remainingUsd(): number {
    return Math.max(0, this.capUsd - this.#spentUsd);
  }

  charge(usd: number): void {
    this.#spentUsd += usd;
  }
}

const EPSILON_USD = 1e-9;

const toIso = (ms: number): string => new Date(ms).toISOString();

export const runPass = async (options: PassOptions, deps: PassDeps): Promise<PassResult> => {
  const budget = new PassBudget(options.capUsd);
  const startedAt = toIso(deps.now());
  const results: ProblemResult[] = [];
  let stopped: PassStop | null = null;

  for (const problem of options.problems) {
    // The month first, then the pass: both are hard limits.
    if (deps.month !== null) {
      const spentUsd = await deps.month.spentUsd();
      if (spentUsd >= deps.month.limitUsd) {
        stopped = {
          reason: 'monthly_budget',
          beforeProblem: problem.id,
          spentUsd,
          limitUsd: deps.month.limitUsd,
        };
        break;
      }
    }
    if (budget.remainingUsd <= EPSILON_USD) {
      stopped = {
        reason: 'pass_cap',
        beforeProblem: problem.id,
        remainingUsd: budget.remainingUsd,
      };
      break;
    }
    const spentBefore = budget.spentUsd;
    const result = await runProblem(problem, options, deps, budget);
    result.costUsd = budget.spentUsd - spentBefore;
    results.push(result);
    deps.log(
      `   ${problem.id}: swarm ${pct(result.scores.swarm)}, baseline ${pct(result.scores.baseline)}, ${result.scores.winner ?? 'not judged'}; $${result.costUsd.toFixed(4)} spent, $${budget.remainingUsd.toFixed(4)} left`,
    );
  }

  const { problems, ...rest } = options;
  return {
    passId: options.passId,
    startedAt,
    endedAt: toIso(deps.now()),
    options: { ...rest, problemIds: problems.map((p) => p.id) },
    results,
    spentUsd: budget.spentUsd,
    stopped,
    aggregate: aggregate(results),
  };
};

const pct = (value: number | null): string => (value === null ? '—' : `${value.toFixed(0)}%`);

const runProblem = async (
  problem: Problem,
  options: PassOptions,
  deps: PassDeps,
  budget: PassBudget,
): Promise<ProblemResult> => {
  const result: ProblemResult = {
    problem,
    swarm: null,
    swarmError: null,
    baseline: null,
    baselineCached: false,
    baselineSkipped: null,
    judgements: [],
    judgeSkipped: [],
    scores: scoreProblem(problem.rubric, []),
    costUsd: 0,
  };
  const tags = (role: string) => ({ role, runId: `eval:${options.passId}`, round: 0 });

  // 1. The swarm, under the smaller of the run cap and what the pass has left.
  deps.log(
    `== ${problem.id}: swarm run (cap $${Math.min(options.runCapUsd, budget.remainingUsd).toFixed(4)}) ==`,
  );
  const swarm = await deps.runSwarm(problem, Math.min(options.runCapUsd, budget.remainingUsd));
  if (!swarm.ok) {
    result.swarmError = swarm.error;
    deps.log(`   swarm failed: ${swarm.error}`);
    return result;
  }
  result.swarm = swarm.value;
  budget.charge(swarm.value.costUsd);
  deps.log(
    `   swarm: ${swarm.value.status}/${swarm.value.reason} after ${String(swarm.value.rounds)} rounds, ${String(swarm.value.entries)} entries, $${swarm.value.costUsd.toFixed(4)}${swarm.value.answer === null ? ', no synthesis' : ''}`,
  );

  // 2. The baseline: cached unless asked otherwise, else one call capped at the swarm's cost.
  const stored = options.refreshBaselines
    ? undefined
    : await deps.cache.get(problem.id, deps.baselineModel.id);
  const cached =
    stored !== undefined && stored.key === baselineCacheKey(problem, deps.baselineModel.id)
      ? stored
      : undefined;
  if (cached !== undefined) {
    result.baseline = cached;
    result.baselineCached = true;
    deps.log(`   baseline: cached (${cached.at}, cap $${cached.capUsd.toFixed(4)})`);
  } else {
    const capUsd = Math.min(swarm.value.costUsd, budget.remainingUsd);
    const generated = await generateBaseline(
      {
        model: deps.baselineModel,
        problem,
        capUsd,
        maxOutputTokens: options.baselineMaxOutputTokens,
      },
      tags('eval-baseline'),
      deps.now(),
    );
    if (!generated.ok) {
      if (generated.error.kind === 'invalid_output') budget.charge(generated.error.usage.costUsd);
      if (generated.error.kind === 'truncated') budget.charge(generated.error.usage.usage.costUsd);
      result.baselineSkipped = describeBaselineError(generated.error);
      deps.log(`   baseline skipped: ${result.baselineSkipped}`);
    } else {
      budget.charge(generated.value.usage.costUsd);
      await deps.cache.put(generated.value);
      result.baseline = generated.value;
      deps.log(
        `   baseline: ${String(generated.value.usage.outputTokens)} of ${String(generated.value.maxOutputTokens)} output tokens used (asked for about ${String(generated.value.wordBudget)} words), $${generated.value.usage.costUsd.toFixed(4)}${generated.value.truncated ? ', TRUNCATED' : ''}`,
      );
    }
  }

  // 3. The judge, blind, in one or both orders.
  if (swarm.value.answer === null || result.baseline === null) {
    result.judgeSkipped.push(
      swarm.value.answer === null ? 'the swarm produced no synthesis' : 'no baseline answer',
    );
    result.scores = scoreProblem(problem.rubric, []);
    // An arm with no answer scores nothing; the other is left unjudged rather than invented.
    if (swarm.value.answer === null && result.baseline !== null) result.scores.swarm = 0;
    if (swarm.value.answer !== null && result.baseline === null) result.scores.baseline = 0;
    return result;
  }
  const first = blindOrder(() => deps.rng());
  const orders: BlindOrder[] = options.judgeOrders === 2 ? [first, swapped(first)] : [first];
  // Both arms pass through the same blinding, so the judge cannot tell them apart by it.
  const answers = {
    swarm: blindText(swarm.value.answer),
    baseline: blindText(result.baseline.answer),
  };
  for (const order of orders) {
    const prompt = judgePrompt(problem, { A: answers[order.A], B: answers[order.B] });
    const schema = judgementSchema(problem);
    const estimate = estimateInput(
      { system: JUDGE_SYSTEM, prompt, schema },
      deps.judgeModel.charsPerToken,
    );
    const fit = fitCall({
      pricing: deps.judgeModel.pricing,
      inputTokens: estimate.tokens,
      maxOutputTokens: options.judgeMaxOutputTokens,
      remainingUsd: budget.remainingUsd,
    });
    if (!fit.fits) {
      result.judgeSkipped.push(
        `order ${order.A}/${order.B}: $${budget.remainingUsd.toFixed(4)} left does not cover the judge call ($${fit.worstCaseUsd.toFixed(4)})`,
      );
      continue;
    }
    const response = await deps.judgeModel.generateObject({
      schema,
      system: JUDGE_SYSTEM,
      prompt,
      maxOutputTokens: fit.maxOutputTokens,
      tags: tags('eval-judge'),
    });
    if (!response.ok) {
      if (response.error.kind === 'invalid_output') budget.charge(response.error.usage.costUsd);
      result.judgeSkipped.push(`order ${order.A}/${order.B}: ${response.error.kind}`);
      continue;
    }
    budget.charge(response.value.usage.costUsd);
    result.judgements.push(unblind(response.value.object, order));
  }
  result.scores = scoreProblem(problem.rubric, result.judgements);
  return result;
};
