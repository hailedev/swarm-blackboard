import {
  zeroUsage,
  type Model,
  type Result,
  type RunEndReason,
  type RunStatus,
  type SynthesisStage,
  type Usage,
} from '@team/core';

import {
  baselineCacheKey,
  baselineIsShort,
  describeBaselineError,
  generateGuardedBaseline,
  sizeBaseline,
  type BaselineCache,
  type BaselineRecord,
} from './baseline';
import type { UnblindedJudgement } from './judge';
import { judgePair } from './judging';
import type { LoopFigures } from './loop';
import type { Problem } from './problems';
import { aggregate, scoreProblem, type Aggregate, type ProblemScores } from './scoring';
import { wordCount } from './words';

// One eval pass (ADR-0012): for each problem, in order, the baseline call, the swarm run
// and the blind judgements. The baseline comes first so that the swarm's final write-up
// can be given the output allowance the baseline really got, and with it the same word
// budget (docs/PLAN.md §2.3 step 8): both arms are asked for one length. The pass has its own dollar cap, enforced here in code like
// every other budget (CLAUDE.md rule 4): a call that cannot fit what is left is skipped
// with a reason, and the pass stops cleanly, with a partial report, when nothing more fits.
// Everything that touches the outside world comes in through `PassDeps`.

export interface SwarmOutcome {
  runId: string;
  /** The latest synthesis's content, or null when the run ended without one. */
  answer: string | null;
  confidence: number | null;
  /**
   * What that answer is: `final` when the run ended with its write-up, `draft` when the
   * last draft is all there is (the write-up failed or was skipped), null with no answer.
   */
  stage: SynthesisStage | null;
  /** The final write-up's call, or null when it never started. */
  writeUp: SwarmWriteUp | null;
  /** Why the write-up did not produce the answer, in the controller's words; null when it did. */
  writeUpFailure: string | null;
  /** How far the run closed its loop: critiques answered, replies lost, subproblems finished. */
  loop: LoopFigures;
  rounds: number;
  status: RunStatus;
  reason: RunEndReason;
  entries: number;
  usage: Usage;
  costUsd: number;
  elapsedMs: number;
}

export interface SwarmWriteUp {
  /** The output allowance the call was given, after fitting what the run had left. */
  maxOutputTokens: number;
  /** The words its prompt asked for. */
  wordBudget: number;
  /** Whether it committed the final answer. */
  written: boolean;
  /** What its calls cost, repairs included; part of the run's cost. */
  costUsd: number;
  /** 2 when the first answer came back under half its word budget and was asked for again. */
  attempts: number;
  /** The answer that was kept is still under half its word budget. */
  short: boolean;
}

export interface MonthGuard {
  spentUsd(): Promise<number>;
  limitUsd: number;
}

export interface PassDeps {
  /**
   * Runs the swarm on a problem under a cost cap; the controller enforces the cap.
   * `writeUpMaxOutputTokens` is the output allowance for the run's final write-up, the
   * baseline's own; null leaves the run's default.
   */
  runSwarm(
    problem: Problem,
    maxCostUsd: number,
    writeUpMaxOutputTokens: number | null,
  ): Promise<Result<SwarmOutcome, string>>;
  baselineModel: Model;
  /**
   * Set when another model writes the baseline in place of the profile's own
   * (`pnpm eval --baseline <alias>`): the profile's own baseline model, used only to size
   * the answer's output allowance under the cap. The stand-in is then asked for the same
   * number of words, and so is the swarm's write-up, whatever the stand-in costs; no call
   * is made to this model. Null otherwise.
   */
  baselineAllowanceModel: Model | null;
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
  /** What the judge calls of this problem used, thinking included. */
  judgeUsage: Usage;
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

/**
 * The allowance a baseline call would be fitted to under `capUsd`; null when none fits.
 * Sized on the profile's own baseline model when a stand-in writes the answer, so the
 * length asked for does not change with who writes it.
 */
const wouldBeAllowance = (
  problem: Problem,
  options: PassOptions,
  deps: PassDeps,
  capUsd: number,
): number | null => {
  const { fit } = sizeBaseline({
    model: deps.baselineAllowanceModel ?? deps.baselineModel,
    problem,
    capUsd,
    maxOutputTokens: options.baselineMaxOutputTokens,
  });
  return fit.fits ? fit.maxOutputTokens : null;
};

const describeAnswer = (swarm: SwarmOutcome): string => {
  if (swarm.answer === null) return ', no synthesis';
  if (swarm.stage === 'final' && swarm.writeUp !== null) {
    return `; final write-up asked for about ${String(swarm.writeUp.wordBudget)} words, $${swarm.writeUp.costUsd.toFixed(4)}${swarm.writeUp.short ? ', STILL SHORT after a second attempt' : swarm.writeUp.attempts > 1 ? ', on the second attempt' : ''}`;
  }
  return `; the answer is a DRAFT${swarm.writeUpFailure === null ? '' : ` (${swarm.writeUpFailure})`}`;
};

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
    judgeUsage: zeroUsage(),
    scores: scoreProblem(problem.rubric, []),
    costUsd: 0,
  };
  const tags = (role: string) => ({ role, runId: `eval:${options.passId}`, round: 0 });

  deps.log(`== ${problem.id} ==`);
  // 1. The baseline: cached unless asked otherwise, else one call under the run cap.
  const stored = options.refreshBaselines
    ? undefined
    : await deps.cache.get(problem.id, deps.baselineModel.id);
  // A cached answer under half its word budget is no baseline (one such was written before
  // the length guard existed): it is made again, as if it were not there.
  const cached =
    stored !== undefined &&
    stored.key === baselineCacheKey(problem, deps.baselineModel.id) &&
    !stored.void &&
    !baselineIsShort(stored)
      ? stored
      : undefined;
  if (cached !== undefined) {
    result.baseline = cached;
    result.baselineCached = true;
    deps.log(`   baseline: cached (${cached.at}, cap $${cached.capUsd.toFixed(4)})`);
  } else {
    // Equal budget means the same cap for both arms (ADR-0013): the run cap, not the swarm's spend.
    const capUsd = Math.min(options.runCapUsd, budget.remainingUsd);
    // A stand-in baseline model is given the allowance the profile's own would have had
    // under this cap, not the larger one its lower price would buy.
    const maxOutputTokens =
      deps.baselineAllowanceModel === null
        ? options.baselineMaxOutputTokens
        : (wouldBeAllowance(problem, options, deps, capUsd) ?? options.baselineMaxOutputTokens);
    // With its length guard: under half its word budget it is asked for once more, and if
    // still short it is void (baseline.ts).
    const generated = await generateGuardedBaseline(
      {
        model: deps.baselineModel,
        problem,
        capUsd,
        maxOutputTokens,
      },
      tags('eval-baseline'),
      () => deps.now(),
    );
    if (!generated.ok) {
      if (generated.error.kind === 'invalid_output') budget.charge(generated.error.usage.costUsd);
      if (generated.error.kind === 'truncated') budget.charge(generated.error.usage.usage.costUsd);
      result.baselineSkipped = describeBaselineError(generated.error);
      deps.log(`   baseline skipped: ${result.baselineSkipped}`);
    } else {
      const { record, costUsd } = generated.value;
      budget.charge(costUsd);
      // A void answer is not kept for later passes: the next one tries again.
      if (!record.void) await deps.cache.put(record);
      result.baseline = record;
      deps.log(
        `   baseline: ${String(record.usage.outputTokens)} of ${String(record.maxOutputTokens)} output tokens used (asked for about ${String(record.wordBudget)} words), $${costUsd.toFixed(4)}${record.truncated ? ', TRUNCATED' : ''}${record.void ? `, VOID: ${describeVoid(record)}` : record.attempts > 1 ? ', on the second attempt' : ''}`,
      );
    }
  }

  // 2. The swarm, under the smaller of the run cap and what the pass has left. Its final
  //    write-up gets the baseline's output allowance, so both arms are asked for the same
  //    number of words; with no baseline to copy, what a baseline would have been given.
  const swarmCapUsd = Math.min(options.runCapUsd, budget.remainingUsd);
  const writeUpMaxOutputTokens =
    result.baseline?.maxOutputTokens ?? wouldBeAllowance(problem, options, deps, swarmCapUsd);
  deps.log(
    `== ${problem.id}: swarm run (cap $${swarmCapUsd.toFixed(4)}${writeUpMaxOutputTokens === null ? '' : `, final write-up allowed ${String(writeUpMaxOutputTokens)} output tokens`}) ==`,
  );
  const swarm = await deps.runSwarm(problem, swarmCapUsd, writeUpMaxOutputTokens);
  if (!swarm.ok) {
    result.swarmError = swarm.error;
    deps.log(`   swarm failed: ${swarm.error}`);
    return result;
  }
  result.swarm = swarm.value;
  budget.charge(swarm.value.costUsd);
  deps.log(
    `   swarm: ${swarm.value.status}/${swarm.value.reason} after ${String(swarm.value.rounds)} rounds, ${String(swarm.value.entries)} entries, $${swarm.value.costUsd.toFixed(4)}${describeAnswer(swarm.value)}`,
  );
  const loop = swarm.value.loop;
  deps.log(
    `   loop: ${String(loop.critiques.resolved)} of ${String(loop.critiques.raised)} critiques resolved, ${String(loop.calls.rejected)} of ${String(loop.calls.made)} calls rejected, ${String(loop.trimmedReplies)} replies trimmed, ${String(loop.decisions)} decisions`,
  );

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
  // A void baseline is not judged and scores nothing, 0 included: the pair is left out of
  // the means, as any pair that was not judged is.
  if (result.baseline.void) {
    result.judgeSkipped.push(`the baseline is void: ${describeVoid(result.baseline)}`);
    result.scores = scoreProblem(problem.rubric, []);
    return result;
  }
  const judged = await judgePair(
    problem,
    { swarm: swarm.value.answer, baseline: result.baseline.answer },
    {
      orders: options.judgeOrders,
      maxOutputTokens: options.judgeMaxOutputTokens,
      tags: tags('eval-judge'),
    },
    deps.judgeModel,
    () => deps.rng(),
    budget,
  );
  result.judgements = judged.judgements;
  result.judgeSkipped.push(...judged.skipped);
  result.judgeUsage = judged.usage;
  result.scores = scoreProblem(problem.rubric, result.judgements);
  return result;
};

/** "5 words of about 900 asked for, after a second attempt". */
export const describeVoid = (record: BaselineRecord): string =>
  `${String(wordCount(record.answer))} words of about ${String(record.wordBudget)} asked for, after a second attempt`;
