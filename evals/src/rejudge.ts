import { err, ok, type Model, type Result, type Usage } from '@team/core';

import {
  baselineCacheKey,
  baselineIsShort,
  describeBaselineError,
  generateGuardedBaseline,
  sizeBaseline,
  type BaselineCache,
  type BaselineRecord,
} from './baseline';
import type { SwarmAnswerOfPass } from './history';
import type { SoloJudgement, UnblindedJudgement } from './judge';
import { judgePair, judgeSolo } from './judging';
import { describeVoid, PassBudget } from './pass';
import type { Problem } from './problems';
import { scoreProblem, weightedPercent, type ProblemScores } from './scoring';
import { wordCount } from './words';

// A judge-only session: answers that already exist are judged again, and nothing else
// runs. No swarm, no controller. Two modes, under one dollar cap enforced here in code:
//
// - pairwise: the swarm's answers of an earlier pass beside the baseline answers of a
//   model, blind and in both orders, exactly as a pass judges a pair (judging.ts);
// - solo: one answer alone against the rubric, nothing beside it.
//
// Between them they separate two things a pass cannot: how far the swarm's own answers
// move from run to run, and how far the judge's score for an answer moves with the answer
// it is read beside. A baseline answer the session needs and the cache does not hold is
// made first, with the baseline's length guard; a void one is not judged.

/** An answer the session can be pointed at. */
export type AnswerRef =
  /** The swarm's answer in an earlier pass, by the pass's label. */
  | { kind: 'swarm'; pass: string }
  /** The cached baseline answer of a roster model alias. */
  | { kind: 'baseline'; alias: string };

export const refKey = (ref: AnswerRef): string =>
  ref.kind === 'swarm' ? `swarm:${ref.pass}` : `baseline:${ref.alias}`;

/** `swarm:<pass>` or `baseline:<alias>`, as the command line names them. */
export const parseAnswerRef = (text: string): Result<AnswerRef, string> => {
  const [kind, name, ...rest] = text.split(':');
  if (rest.length > 0 || name === undefined || name === '') {
    return err(`"${text}" is not swarm:<pass> or baseline:<alias>`);
  }
  if (kind === 'swarm') return ok({ kind, pass: name });
  if (kind === 'baseline') return ok({ kind, alias: name });
  return err(`"${text}" is not swarm:<pass> or baseline:<alias>`);
};

export interface SourcedAnswer {
  ref: AnswerRef;
  problemId: string;
  text: string;
  words: number;
  /** The words it was asked for, when its source says. */
  wordBudget: number | null;
  /** Where it came from: the swarm's run id, or the baseline's model id. */
  origin: string;
}

export interface RejudgeDeps {
  judgeModel: Model;
  cache: BaselineCache;
  /** The model behind each baseline alias the session names. */
  baselineModels: ReadonlyMap<string, Model>;
  /** The profile's own baseline model: it sizes the allowance of a baseline that has to be made. */
  allowanceModel: Model;
  /** The swarm's answer on a problem in an earlier pass, from that pass's report. */
  swarmAnswer(pass: string, problemId: string): Result<SwarmAnswerOfPass, string>;
  now(): number;
  log(line: string): void;
  rng(): number;
}

export interface RejudgeOptions {
  sessionId: string;
  problems: readonly Problem[];
  /** Hard cap on what the whole session may spend. */
  capUsd: number;
  /** The cap a baseline call is sized under, as in a pass. */
  runCapUsd: number;
  /** Pairwise: each pass's swarm answers beside each alias's baselines. */
  pairs: readonly { pass: string; alias: string }[];
  /** Solo: each of these, once per problem. */
  solo: readonly AnswerRef[];
  judgeOrders: 1 | 2;
  judgeMaxOutputTokens: number;
  baselineMaxOutputTokens: number;
}

export interface PairResult {
  problemId: string;
  pass: string;
  alias: string;
  swarm: SourcedAnswer | null;
  baseline: SourcedAnswer | null;
  judgements: UnblindedJudgement[];
  /** Why the pair, or one of its orders, was not judged. */
  skipped: string[];
  scores: ProblemScores;
  usage: Usage | null;
}

export interface SoloResult {
  problemId: string;
  ref: AnswerRef;
  answer: SourcedAnswer | null;
  judgement: SoloJudgement | null;
  /** The weighted rubric percentage, as a pass computes it; null when not judged. */
  percent: number | null;
  skipped: string | null;
}

/** A baseline answer the session had to make because the cache had none it could use. */
export interface BaselineMade {
  problemId: string;
  alias: string;
  record: BaselineRecord;
  costUsd: number;
}

export interface RejudgeResult {
  sessionId: string;
  startedAt: string;
  endedAt: string;
  capUsd: number;
  spentUsd: number;
  problemIds: string[];
  pairs: PairResult[];
  solo: SoloResult[];
  made: BaselineMade[];
}

const toIso = (ms: number): string => new Date(ms).toISOString();

export const runRejudge = async (
  options: RejudgeOptions,
  deps: RejudgeDeps,
): Promise<RejudgeResult> => {
  const budget = new PassBudget(options.capUsd);
  const startedAt = toIso(deps.now());
  const made: BaselineMade[] = [];
  const tags = (role: string) => ({ role, runId: `eval:${options.sessionId}`, round: 0 });

  // A baseline answer: the cached one when it is still this problem's and not short;
  // otherwise made now, under the run cap and what the session has left, at the allowance
  // the profile's own baseline model would be given (pass.ts does the same for a stand-in).
  const baselineAnswer = async (
    alias: string,
    problem: Problem,
  ): Promise<Result<SourcedAnswer, string>> => {
    const model = deps.baselineModels.get(alias);
    if (model === undefined) return err(`no baseline model for the alias "${alias}"`);
    const sourced = (record: BaselineRecord): SourcedAnswer => ({
      ref: { kind: 'baseline', alias },
      problemId: problem.id,
      text: record.answer,
      words: wordCount(record.answer),
      wordBudget: record.wordBudget,
      origin: record.modelId,
    });
    const stored = await deps.cache.get(problem.id, model.id);
    if (
      stored !== undefined &&
      stored.key === baselineCacheKey(problem, model.id) &&
      !stored.void &&
      !baselineIsShort(stored)
    ) {
      return ok(sourced(stored));
    }
    const capUsd = Math.min(options.runCapUsd, budget.remainingUsd);
    const allowance = sizeBaseline({
      model: deps.allowanceModel,
      problem,
      capUsd,
      maxOutputTokens: options.baselineMaxOutputTokens,
    }).fit;
    const generated = await generateGuardedBaseline(
      {
        model,
        problem,
        capUsd,
        maxOutputTokens: allowance.fits
          ? allowance.maxOutputTokens
          : options.baselineMaxOutputTokens,
      },
      tags('eval-baseline'),
      () => deps.now(),
    );
    if (!generated.ok) {
      if (generated.error.kind === 'invalid_output') budget.charge(generated.error.usage.costUsd);
      if (generated.error.kind === 'truncated') budget.charge(generated.error.usage.usage.costUsd);
      return err(
        `the ${alias} baseline could not be made: ${describeBaselineError(generated.error)}`,
      );
    }
    const { record, costUsd } = generated.value;
    budget.charge(costUsd);
    made.push({ problemId: problem.id, alias, record, costUsd });
    deps.log(
      `   ${problem.id}: ${alias} baseline made, ${String(wordCount(record.answer))} words of about ${String(record.wordBudget)} asked for, $${costUsd.toFixed(4)}${record.attempts > 1 ? ', on the second attempt' : ''}${record.void ? ', VOID' : ''}`,
    );
    if (record.void) return err(`the ${alias} baseline is void: ${describeVoid(record)}`);
    await deps.cache.put(record);
    return ok(sourced(record));
  };

  // Each answer is looked up once: the same baseline text is judged pairwise and solo.
  const found = new Map<string, Promise<Result<SourcedAnswer, string>>>();
  const answerOf = (ref: AnswerRef, problem: Problem): Promise<Result<SourcedAnswer, string>> => {
    const key = `${refKey(ref)}|${problem.id}`;
    const known = found.get(key);
    if (known !== undefined) return known;
    const lookup =
      ref.kind === 'baseline'
        ? baselineAnswer(ref.alias, problem)
        : Promise.resolve(deps.swarmAnswer(ref.pass, problem.id)).then(
            (swarm): Result<SourcedAnswer, string> =>
              swarm.ok
                ? ok({
                    ref,
                    problemId: problem.id,
                    text: swarm.value.answer,
                    words: wordCount(swarm.value.answer),
                    wordBudget: swarm.value.wordBudget,
                    origin: swarm.value.runId,
                  })
                : swarm,
          );
    found.set(key, lookup);
    return lookup;
  };

  // 1. Pairwise.
  const pairs: PairResult[] = [];
  for (const { pass, alias } of options.pairs) {
    deps.log(`== pairwise: the swarm answers of ${pass} beside the ${alias} baselines ==`);
    for (const problem of options.problems) {
      const swarm = await answerOf({ kind: 'swarm', pass }, problem);
      const baseline = await answerOf({ kind: 'baseline', alias }, problem);
      const result: PairResult = {
        problemId: problem.id,
        pass,
        alias,
        swarm: swarm.ok ? swarm.value : null,
        baseline: baseline.ok ? baseline.value : null,
        judgements: [],
        skipped: [],
        scores: scoreProblem(problem.rubric, []),
        usage: null,
      };
      if (!swarm.ok) result.skipped.push(swarm.error);
      if (!baseline.ok) result.skipped.push(baseline.error);
      if (swarm.ok && baseline.ok) {
        const judged = await judgePair(
          problem,
          { swarm: swarm.value.text, baseline: baseline.value.text },
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
        result.skipped.push(...judged.skipped);
        result.usage = judged.usage;
        result.scores = scoreProblem(problem.rubric, judged.judgements);
      }
      pairs.push(result);
      const pct = (value: number | null): string => (value === null ? '—' : `${value.toFixed(1)}%`);
      deps.log(
        `   ${problem.id}: swarm ${pct(result.scores.swarm)}, baseline ${pct(result.scores.baseline)}, ${result.scores.winner ?? 'not judged'}${result.skipped.length === 0 ? '' : ` (${result.skipped.join('; ')})`}; $${budget.remainingUsd.toFixed(4)} left`,
      );
    }
  }

  // 2. Every answer the solo scoring needs, found or made before any of it is scored.
  if (options.solo.length > 0) deps.log('== solo: one answer at a time against the rubric ==');
  for (const problem of options.problems) {
    for (const ref of options.solo) await answerOf(ref, problem);
  }

  // 3. Solo.
  const solo: SoloResult[] = [];
  for (const problem of options.problems) {
    for (const ref of options.solo) {
      const answer = await answerOf(ref, problem);
      if (!answer.ok) {
        solo.push({
          problemId: problem.id,
          ref,
          answer: null,
          judgement: null,
          percent: null,
          skipped: answer.error,
        });
        deps.log(`   ${problem.id} ${refKey(ref)}: not scored (${answer.error})`);
        continue;
      }
      const judged = await judgeSolo(
        problem,
        answer.value.text,
        { maxOutputTokens: options.judgeMaxOutputTokens, tags: tags('eval-judge-solo') },
        deps.judgeModel,
        budget,
      );
      const percent =
        judged.judgement === null ? null : weightedPercent(problem.rubric, judged.judgement.scores);
      solo.push({
        problemId: problem.id,
        ref,
        answer: answer.value,
        judgement: judged.judgement,
        percent,
        skipped: judged.skipped,
      });
      deps.log(
        `   ${problem.id} ${refKey(ref)}: ${percent === null ? `not scored (${judged.skipped ?? 'no judgement'})` : `${percent.toFixed(1)}%`}; $${budget.remainingUsd.toFixed(4)} left`,
      );
    }
  }

  return {
    sessionId: options.sessionId,
    startedAt,
    endedAt: toIso(deps.now()),
    capUsd: options.capUsd,
    spentUsd: budget.spentUsd,
    problemIds: options.problems.map((p) => p.id),
    pairs,
    solo,
    made,
  };
};
