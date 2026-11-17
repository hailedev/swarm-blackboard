import { isoFromMs, type Model, type Result } from '@team/core';

import {
  describeBaselineError,
  generateGuardedBaseline,
  sizeBaseline,
  type BaselineError,
} from './baseline';
import { judgeSolo } from './judging';
import {
  answerId,
  armRef,
  type AnswerDetail,
  type AnswerKey,
  type Arm,
  type MeasuredAnswer,
  type MeasureStore,
  type ScoreKey,
  type ScoreRecord,
} from './measure-store';
import { describeVoid, PassBudget, type MonthGuard, type SwarmOutcome } from './pass';
import type { Problem } from './problems';
import { weightedPercent } from './scoring';
import type { RunSwarm } from './swarm-runner';
import { isShort, wordCount } from './words';

// A measurement (`pnpm eval:measure`): several arms on every problem, each answer scored
// alone against the rubric, several times. An arm is one call of a model (the baseline's
// prompt, unchanged) or a swarm profile run several times per problem; every arm is asked
// for the same number of words. Two stages, each resumable and each under a dollar cap of
// its own that holds across invocations, enforced here in code (CLAUDE.md rule 4):
//
//   generate  makes the answers                        (answers/<problem>/<arm>[--rN].json)
//   score     scores each answer alone, N times        (scores/<problem>/<arm>[--rN]--sK.json)
//
// A stage skips whatever is already on disk and tries again only what `failed`. Nothing is
// judged pairwise: on 2026-11-17 a pairwise score moved 18 to 29 points with the answer it
// was read beside (evals/results/2026-11-17-judge-only), so an answer's own score is the
// yardstick. Everything that touches the outside world comes in through the deps.

const EPSILON_USD = 1e-9;

export interface StageTally {
  /** Items the invocation looked at. */
  items: number;
  /** Already on disk with an outcome: left alone. */
  onDisk: number;
  /** New outcomes this invocation: answered or void, or scored. */
  done: number;
  /** Attempted and failed for an outside reason: tried again next time. */
  failed: number;
  /** Not attempted: the stage's cap or the month's limit did not cover them. */
  notRun: number;
  /** Spent by this invocation, and by the stage so far, against its cap. */
  spentUsd: number;
  stageSpentUsd: number;
  capUsd: number;
  /** Why paid items stopped being attempted altogether, when they did. */
  stopped: string | null;
}

const emptyTally = (capUsd: number, stageSpentUsd: number): StageTally => ({
  items: 0,
  onDisk: 0,
  done: 0,
  failed: 0,
  notRun: 0,
  spentUsd: 0,
  stageSpentUsd,
  capUsd,
  stopped: null,
});

// ── What to do, in what order ────────────────────────────────────────────────────────────

/**
 * Every answer of the measurement, in the order they are made: arm by arm as given, so a
 * local model is loaded once for all the work that needs it; within a swarm arm run 1 of
 * every problem, then run 2, so a cap that bites late thins every problem equally instead
 * of leaving the last ones with nothing.
 */
export const answerKeys = (
  problemIds: readonly string[],
  arms: readonly Arm[],
  runs: number,
): AnswerKey[] =>
  arms.flatMap((arm): AnswerKey[] =>
    arm.kind === 'call'
      ? problemIds.map((problemId) => ({ problemId, arm, run: 1 }))
      : Array.from({ length: runs }, (_, i) => i + 1).flatMap((run) =>
          problemIds.map((problemId) => ({ problemId, arm, run })),
        ),
  );

/**
 * Every score, in the order they are given: the first score of every answer, then the
 * second, and within a sweep problem by problem, so a cap that bites costs some later
 * scores of the last problems across every arm alike, never an arm.
 */
export const scoreKeys = (
  problemIds: readonly string[],
  arms: readonly Arm[],
  runs: number,
  scores: number,
): ScoreKey[] =>
  Array.from({ length: scores }, (_, i) => i + 1).flatMap((score) =>
    problemIds.flatMap((problemId) =>
      arms.flatMap((arm) =>
        Array.from({ length: arm.kind === 'call' ? 1 : runs }, (_, i) => i + 1).map((run) => ({
          problemId,
          arm,
          run,
          score,
        })),
      ),
    ),
  );

// ── Sizing: the same length for every arm ────────────────────────────────────────────────

export interface AnswerSize {
  problemId: string;
  /** The output allowance every arm's answer gets on this problem; null when none fits. */
  maxOutputTokens: number | null;
  /** The words that allowance buys: what every arm is asked for. */
  wordBudget: number;
}

/**
 * The output allowance, and with it the word budget, every arm is given on each problem:
 * what the sizing model's single call fits under the run cap, as `pnpm eval --baseline`
 * sizes a stand-in. A cheaper or free model is given this allowance, not the larger one
 * its price would buy, and so is the swarm's write-up.
 */
export const sizeAnswers = (
  problems: readonly Problem[],
  sizingModel: Model,
  runCapUsd: number,
  maxOutputTokens: number,
): AnswerSize[] =>
  problems.map((problem) => {
    const sized = sizeBaseline({ model: sizingModel, problem, capUsd: runCapUsd, maxOutputTokens });
    return {
      problemId: problem.id,
      maxOutputTokens: sized.fit.fits ? sized.fit.maxOutputTokens : null,
      wordBudget: sized.wordBudget,
    };
  });

/** The problems that would not be asked for the measurement's word budget, one line each. */
export const sizeProblems = (sizes: readonly AnswerSize[], wordBudget: number): string[] =>
  sizes
    .filter((size) => size.maxOutputTokens === null || size.wordBudget !== wordBudget)
    .map((size) =>
      size.maxOutputTokens === null
        ? `${size.problemId}: no answer fits the run cap`
        : `${size.problemId}: the run cap buys ${String(size.maxOutputTokens)} output tokens, about ${String(size.wordBudget)} words, not ${String(wordBudget)}`,
    );

// ── Stage 1: the answers ─────────────────────────────────────────────────────────────────

export interface GenerateOptions {
  sessionId: string;
  problems: readonly Problem[];
  arms: readonly Arm[];
  runs: number;
  /** Hard cap on the whole stage, across every invocation of it. */
  capUsd: number;
  /** The cap on each swarm run, and the cap the answer's length is sized under. */
  runCapUsd: number;
  /** The words every answer is asked for; the stage refuses a problem that sizes otherwise. */
  wordBudget: number;
  /** The most output an answer may be allowed, before the run cap shrinks it. */
  maxOutputTokens: number;
}

export interface SwarmArm {
  run: RunSwarm;
  /** Whether a run can spend API money. */
  paid: boolean;
}

export interface GenerateDeps {
  store: MeasureStore;
  /** Sizes every answer's allowance; no call is made to it unless it is also an arm. */
  sizingModel: Model;
  /** The model behind a call arm's alias. */
  callModel(alias: string): Result<Model, string>;
  /** The swarm of a profile, built when its first run is due (a local model is loaded then). */
  swarm(profile: string): Promise<Result<SwarmArm, string>>;
  /** Present when anything is paid: re-read before each paid item. */
  month: MonthGuard | null;
  commit: string | null;
  now(): number;
  log(line: string): void;
}

const swarmDetail = (outcome: SwarmOutcome): AnswerDetail => ({
  kind: 'swarm',
  runId: outcome.runId,
  rounds: outcome.rounds,
  status: outcome.status,
  reason: outcome.reason,
  entries: outcome.entries,
  elapsedMs: outcome.elapsedMs,
  usage: outcome.usage,
  confidence: outcome.confidence,
  stage: outcome.stage,
  writeUp: outcome.writeUp,
  writeUpFailure: outcome.writeUpFailure,
  critiques: {
    raised: outcome.loop.critiques.raised,
    resolved: outcome.loop.critiques.resolved,
  },
  calls: outcome.loop.calls,
});

/** What a failed baseline call cost: an answer that failed the schema was still billed. */
const costOfError = (error: BaselineError): number => {
  if (error.kind === 'invalid_output') return error.usage.costUsd;
  if (error.kind === 'truncated') return error.usage.usage.costUsd;
  return 0;
};

/** The provider has refused the account: no further paid call is worth making. */
const REFUSALS: readonly string[] = ['billing', 'auth'];

export const runGenerate = async (
  options: GenerateOptions,
  deps: GenerateDeps,
): Promise<Result<StageTally, string[]>> => {
  // Nothing is spent before every problem is known to be asked for the same words.
  const sizes = sizeAnswers(
    options.problems,
    deps.sizingModel,
    options.runCapUsd,
    options.maxOutputTokens,
  );
  const wrong = sizeProblems(sizes, options.wordBudget);
  if (wrong.length > 0) return { ok: false, error: wrong };
  const allowanceOf = new Map(sizes.map((size) => [size.problemId, size.maxOutputTokens]));

  // The cap is the stage's, not the invocation's: what earlier invocations spent is in
  // the records they left.
  const before = (await deps.store.listAnswers()).reduce((sum, a) => sum + a.spentUsd, 0);
  const budget = new PassBudget(options.capUsd);
  budget.charge(before);
  const tally = emptyTally(options.capUsd, before);
  const problemOf = new Map(options.problems.map((p) => [p.id, p]));
  const tags = (role: string) => ({ role, runId: `eval:${options.sessionId}`, round: 0 });
  // Why paid items are no longer attempted, once they are not: free arms go on regardless.
  let stopped: string | null = null;

  const keys = answerKeys(
    options.problems.map((p) => p.id),
    options.arms,
    options.runs,
  );
  for (const key of keys) {
    tally.items += 1;
    const problem = problemOf.get(key.problemId);
    const allowance = allowanceOf.get(key.problemId);
    if (problem === undefined || allowance == null) continue;
    const prior = await deps.store.readAnswer(key);
    if (prior !== undefined && prior.outcome !== 'failed') {
      tally.onDisk += 1;
      continue;
    }
    const base = {
      problemId: key.problemId,
      arm: key.arm,
      run: key.run,
      commit: deps.commit,
      tries: (prior?.tries ?? 0) + 1,
    };
    const carried = prior?.spentUsd ?? 0;
    const name = answerId(key);
    // What this attempt costs, charged to the stage as it is incurred.
    let cost = 0;
    const charge = (usd: number): void => {
      cost += usd;
      budget.charge(usd);
    };
    const record = (
      rest:
        | Pick<Extract<MeasuredAnswer, { outcome: 'answered' }>, 'outcome' | 'text' | 'detail'>
        | Pick<Extract<MeasuredAnswer, { outcome: 'void' }>, 'outcome' | 'text' | 'detail' | 'why'>
        | Pick<Extract<MeasuredAnswer, { outcome: 'failed' }>, 'outcome' | 'why'>,
      wordBudget: number | null,
    ): MeasuredAnswer => {
      const common = {
        ...base,
        at: isoFromMs(deps.now()),
        spentUsd: carried + cost,
      };
      if (rest.outcome === 'failed') return { ...common, ...rest };
      const words = rest.text === null ? 0 : wordCount(rest.text);
      if (rest.outcome === 'void') return { ...common, ...rest, words, wordBudget };
      return { ...common, ...rest, words, wordBudget: wordBudget ?? options.wordBudget };
    };
    const keep = async (answer: MeasuredAnswer): Promise<void> => {
      await deps.store.writeAnswer(answer);
      if (answer.outcome === 'failed') tally.failed += 1;
      else tally.done += 1;
      const spent = `$${cost.toFixed(4)}`;
      deps.log(
        answer.outcome === 'failed'
          ? `   ${name}: FAILED (${answer.why}); ${spent}`
          : answer.outcome === 'void'
            ? `   ${name}: VOID (${answer.why}); ${spent}`
            : `   ${name}: ${String(answer.words)} words of about ${String(answer.wordBudget)}${describeAnswered(answer.detail)}; ${spent}, $${budget.remainingUsd.toFixed(4)} left`,
      );
    };
    const notRun = (why: string): void => {
      tally.notRun += 1;
      deps.log(`   ${name}: not run (${why})`);
    };
    /**
     * Why no paid item is to be attempted any more, or null: a refusal met earlier, or the
     * month's limit, which is re-read before each paid item.
     */
    const paidStop = async (): Promise<string | null> => {
      if (stopped !== null || deps.month === null) return stopped;
      const spentUsd = await deps.month.spentUsd();
      if (spentUsd >= deps.month.limitUsd) {
        stopped = `monthly_budget: $${spentUsd.toFixed(4)} of $${deps.month.limitUsd.toFixed(2)} spent`;
      }
      return stopped;
    };

    if (key.arm.kind === 'call') {
      const model = deps.callModel(key.arm.alias);
      if (!model.ok) {
        await keep(record({ outcome: 'failed', why: model.error }, null));
        continue;
      }
      const paid = model.value.pricing !== null;
      const stop = paid ? await paidStop() : null;
      if (stop !== null) {
        notRun(stop);
        continue;
      }
      const request = {
        model: model.value,
        problem,
        capUsd: paid ? Math.min(options.runCapUsd, budget.remainingUsd) : options.runCapUsd,
        maxOutputTokens: allowance,
      };
      // The call is made only at its whole allowance: one shrunk to fit what the stage has
      // left would be asked for fewer words than every other answer.
      const fit = sizeBaseline(request).fit;
      if (!fit.fits || fit.maxOutputTokens < allowance) {
        notRun(`the stage cap has $${budget.remainingUsd.toFixed(4)} left`);
        continue;
      }
      const generated = await generateGuardedBaseline(request, tags('eval-baseline'), () =>
        deps.now(),
      );
      if (!generated.ok) {
        charge(costOfError(generated.error));
        if (REFUSALS.includes(generated.error.kind)) stopped = generated.error.kind;
        await keep(
          record({ outcome: 'failed', why: describeBaselineError(generated.error) }, null),
        );
        continue;
      }
      const made = generated.value.record;
      charge(generated.value.costUsd);
      const detail: AnswerDetail = {
        kind: 'call',
        modelId: made.modelId,
        maxOutputTokens: made.maxOutputTokens,
        usage: made.usage,
        latencyMs: made.latencyMs,
        attempts: made.attempts,
        truncated: made.truncated,
      };
      await keep(
        made.void
          ? record(
              { outcome: 'void', why: describeVoid(made), text: made.answer, detail },
              made.wordBudget,
            )
          : record({ outcome: 'answered', text: made.answer, detail }, made.wordBudget),
      );
      continue;
    }

    // A swarm arm. Its models are built now, when the first run is due.
    const swarm = await deps.swarm(key.arm.profile);
    if (!swarm.ok) {
      await keep(record({ outcome: 'failed', why: swarm.error }, null));
      continue;
    }
    if (swarm.value.paid) {
      const stop = await paidStop();
      if (stop !== null) {
        notRun(stop);
        continue;
      }
      // A run under a smaller cap than the others is not the same arm: all or nothing.
      if (budget.remainingUsd < options.runCapUsd - EPSILON_USD) {
        notRun(
          `the stage cap has $${budget.remainingUsd.toFixed(4)} left, a run needs its whole cap`,
        );
        continue;
      }
    }
    deps.log(`== ${name}: swarm run (cap $${options.runCapUsd.toFixed(4)}) ==`);
    const ran = await swarm.value.run(problem, options.runCapUsd, allowance);
    if (!ran.ok) {
      await keep(record({ outcome: 'failed', why: ran.error }, null));
      continue;
    }
    const outcome = ran.value;
    charge(outcome.costUsd);
    const detail = swarmDetail(outcome);
    const ending = `${outcome.status}/${outcome.reason} after ${String(outcome.rounds)} rounds`;
    // A run that did not end is not an answer: the local model went away, the provider
    // was overloaded, the month ran out. Tried again by the next invocation.
    if (outcome.status === 'paused' || outcome.status === 'failed') {
      if ([...REFUSALS, 'monthly_budget'].includes(outcome.reason)) stopped = outcome.reason;
      await keep(record({ outcome: 'failed', why: `the run ended ${ending}` }, null));
      continue;
    }
    const asked = outcome.writeUp?.wordBudget ?? null;
    if (outcome.answer === null) {
      await keep(
        record({ outcome: 'void', why: `no synthesis: ${ending}`, text: null, detail }, asked),
      );
      continue;
    }
    // The call arms' rule, for a write-up: under half its word budget after its retry it
    // is not an answer to score. A draft that stands in for a failed write-up was never
    // asked for that length: it is kept, and flagged as a draft.
    const words = wordCount(outcome.answer);
    if (outcome.stage === 'final' && asked !== null && isShort(words, asked)) {
      await keep(
        record(
          {
            outcome: 'void',
            why: `${String(words)} words of about ${String(asked)} asked for${(outcome.writeUp?.attempts ?? 1) > 1 ? ', after a second attempt' : ''}`,
            text: outcome.answer,
            detail,
          },
          asked,
        ),
      );
      continue;
    }
    await keep(record({ outcome: 'answered', text: outcome.answer, detail }, asked));
  }

  tally.stopped = stopped;
  tally.spentUsd = budget.spentUsd - before;
  tally.stageSpentUsd = budget.spentUsd;
  return { ok: true, value: tally };
};

const describeAnswered = (detail: AnswerDetail): string => {
  if (detail.kind === 'call') {
    return `${detail.attempts > 1 ? ', on the second attempt' : ''}${detail.truncated ? ', TRUNCATED' : ''}`;
  }
  const notes = [`${detail.reason} after ${String(detail.rounds)} rounds`];
  if (detail.stage !== 'final') notes.push(`a DRAFT (${detail.writeUpFailure ?? 'no write-up'})`);
  if (detail.writeUp !== null && detail.writeUp.retriedFor.length > 0) {
    notes.push(`write-up asked again for ${detail.writeUp.retriedFor.join(' and ')}`);
  }
  if (detail.writeUp !== null && detail.writeUp.leaks.length > 0) {
    notes.push(`${String(detail.writeUp.leaks.length)} sentence(s) still LEAK`);
  }
  return `, ${notes.join(', ')}`;
};

// ── Stage 2: the scores ──────────────────────────────────────────────────────────────────

export interface ScoreOptions {
  sessionId: string;
  problems: readonly Problem[];
  arms: readonly Arm[];
  runs: number;
  /** How many times each answer is scored. */
  scores: number;
  /** Hard cap on the whole stage, across every invocation of it. */
  capUsd: number;
  judgeMaxOutputTokens: number;
}

export interface ScoreDeps {
  store: MeasureStore;
  judgeModel: Model;
  month: MonthGuard | null;
  now(): number;
  log(line: string): void;
}

export const runScore = async (options: ScoreOptions, deps: ScoreDeps): Promise<StageTally> => {
  const before = (await deps.store.listScores()).reduce((sum, s) => sum + s.spentUsd, 0);
  const budget = new PassBudget(options.capUsd);
  budget.charge(before);
  const tally = emptyTally(options.capUsd, before);
  const problemOf = new Map(options.problems.map((p) => [p.id, p]));
  const tags = { role: 'eval-judge-solo', runId: `eval:${options.sessionId}`, round: 0 };

  const keys = scoreKeys(
    options.problems.map((p) => p.id),
    options.arms,
    options.runs,
    options.scores,
  );
  for (const key of keys) {
    const problem = problemOf.get(key.problemId);
    const answer = await deps.store.readAnswer(key);
    // Only an answer is scored: a void one is left out of the means, a failed one is not there.
    if (problem === undefined || answer?.outcome !== 'answered') continue;
    tally.items += 1;
    const prior = await deps.store.readScore(key);
    if (prior?.outcome === 'scored') {
      tally.onDisk += 1;
      continue;
    }
    const name = `${answerId(key)} score ${String(key.score)}`;
    if (tally.stopped !== null) {
      tally.notRun += 1;
      continue;
    }
    if (deps.month !== null) {
      const spentUsd = await deps.month.spentUsd();
      if (spentUsd >= deps.month.limitUsd) {
        tally.stopped = `monthly_budget: $${spentUsd.toFixed(4)} of $${deps.month.limitUsd.toFixed(2)} spent`;
        tally.notRun += 1;
        deps.log(`   ${name}: not run (${tally.stopped})`);
        continue;
      }
    }
    const judged = await judgeSolo(
      problem,
      answer.text,
      { maxOutputTokens: options.judgeMaxOutputTokens, tags, whole: true },
      deps.judgeModel,
      budget,
    );
    // The calls are much of a size: once one does not fit what is left, none will.
    if (!judged.fits) {
      tally.stopped = `stage cap: ${judged.skipped ?? 'the judge call does not fit'}`;
      tally.notRun += 1;
      deps.log(`   ${name}: not run (${tally.stopped})`);
      continue;
    }
    const base = {
      problemId: key.problemId,
      arm: key.arm,
      run: key.run,
      score: key.score,
      at: isoFromMs(deps.now()),
      judgeModelId: deps.judgeModel.id,
      spentUsd: (prior?.spentUsd ?? 0) + judged.usage.costUsd,
      tries: (prior?.tries ?? 0) + 1,
    };
    let record: ScoreRecord;
    if (judged.judgement === null) {
      if (judged.error !== null && REFUSALS.includes(judged.error)) tally.stopped = judged.error;
      record = { ...base, outcome: 'failed', why: judged.skipped ?? 'no judgement' };
      tally.failed += 1;
      deps.log(`   ${name}: FAILED (${record.why})`);
    } else {
      record = {
        ...base,
        outcome: 'scored',
        percent: weightedPercent(problem.rubric, judged.judgement.scores),
        scores: judged.judgement.scores,
        note: judged.judgement.note,
        usage: judged.usage,
      };
      tally.done += 1;
      deps.log(
        `   ${name}: ${record.percent.toFixed(1)}%; $${judged.usage.costUsd.toFixed(4)}, $${budget.remainingUsd.toFixed(4)} left`,
      );
    }
    await deps.store.writeScore(record);
  }

  tally.spentUsd = budget.spentUsd - before;
  tally.stageSpentUsd = budget.spentUsd;
  return tally;
};

/** What a stage's invocation did, in one line. */
export const describeTally = (stage: string, tally: StageTally, unit: string): string =>
  `${stage}: ${String(tally.done)} ${unit} made, ${String(tally.onDisk)} already on disk, ${String(tally.failed)} failed, ${String(tally.notRun)} not run; spent $${tally.spentUsd.toFixed(4)} now, $${tally.stageSpentUsd.toFixed(4)} of the stage's $${tally.capUsd.toFixed(2)}${tally.stopped === null ? '' : `; stopped: ${tally.stopped}`}`;

/** The arms of a measurement, as one line. */
export const describeArms = (arms: readonly Arm[]): string => arms.map(armRef).join(', ');
