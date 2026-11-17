import {
  addUsage,
  estimateInput,
  fitCall,
  zeroUsage,
  type Model,
  type ModelCallTags,
  type ModelErrorKind,
  type Usage,
} from '@team/core';

import {
  blindOrder,
  blindText,
  JUDGE_SYSTEM,
  judgePrompt,
  judgementSchema,
  SOLO_JUDGE_SYSTEM,
  soloJudgePrompt,
  soloJudgementSchema,
  swapped,
  unblind,
  type BlindOrder,
  type SoloJudgement,
  type UnblindedJudgement,
} from './judge';
import type { Problem } from './problems';

// The judge's calls, each fitted to what the pass or session has left before it is made
// (CLAUDE.md rule 4: budgets are enforced in code) and charged after it returns. Used by an
// eval pass (pass.ts) and by a judge-only session (rejudge.ts).

/** What is left to spend, and where a call's cost goes. `PassBudget` is one. */
export interface JudgeBudget {
  readonly remainingUsd: number;
  charge(usd: number): void;
}

export interface JudgeCallOptions {
  maxOutputTokens: number;
  tags: ModelCallTags;
  /**
   * Make the call only at its whole output allowance: when what is left would shrink it,
   * the call is not made. A judgement cut short by a small allowance is worse than none.
   */
  whole?: boolean;
}

export interface PairJudging {
  judgements: UnblindedJudgement[];
  /** One line per order that was not judged, with the reason. */
  skipped: string[];
  usage: Usage;
}

/**
 * Two answers side by side, blind to which arm wrote which, in one order drawn from `rng`
 * or in that order and its mirror. Both answers pass through the same blinding.
 */
export const judgePair = async (
  problem: Problem,
  answers: { swarm: string; baseline: string },
  options: JudgeCallOptions & { orders: 1 | 2 },
  judgeModel: Model,
  rng: () => number,
  budget: JudgeBudget,
): Promise<PairJudging> => {
  const result: PairJudging = { judgements: [], skipped: [], usage: zeroUsage() };
  const first = blindOrder(rng);
  const orders: BlindOrder[] = options.orders === 2 ? [first, swapped(first)] : [first];
  const blind = { swarm: blindText(answers.swarm), baseline: blindText(answers.baseline) };
  for (const order of orders) {
    const prompt = judgePrompt(problem, { A: blind[order.A], B: blind[order.B] });
    const schema = judgementSchema(problem);
    const estimate = estimateInput(
      { system: JUDGE_SYSTEM, prompt, schema },
      judgeModel.charsPerToken,
    );
    const fit = fitCall({
      pricing: judgeModel.pricing,
      inputTokens: estimate.tokens,
      maxOutputTokens: options.maxOutputTokens,
      remainingUsd: budget.remainingUsd,
    });
    if (!fit.fits) {
      result.skipped.push(
        `order ${order.A}/${order.B}: $${budget.remainingUsd.toFixed(4)} left does not cover the judge call ($${fit.worstCaseUsd.toFixed(4)})`,
      );
      continue;
    }
    const response = await judgeModel.generateObject({
      schema,
      system: JUDGE_SYSTEM,
      prompt,
      maxOutputTokens: fit.maxOutputTokens,
      tags: options.tags,
    });
    if (!response.ok) {
      if (response.error.kind === 'invalid_output') {
        budget.charge(response.error.usage.costUsd);
        result.usage = addUsage(result.usage, response.error.usage);
      }
      result.skipped.push(`order ${order.A}/${order.B}: ${response.error.kind}`);
      continue;
    }
    budget.charge(response.value.usage.costUsd);
    result.usage = addUsage(result.usage, response.value.usage);
    result.judgements.push(unblind(response.value.object, order));
  }
  return result;
};

export interface SoloJudging {
  /** Null when the call was not made or failed; `skipped` then says why. */
  judgement: SoloJudgement | null;
  skipped: string | null;
  usage: Usage;
  /** False when the call was not made because what is left of the budget does not cover it. */
  fits: boolean;
  /** How the call failed, when it was made and failed. */
  error: ModelErrorKind | null;
}

/** One answer alone against the rubric: no second answer in the prompt, nothing to compare with. */
export const judgeSolo = async (
  problem: Problem,
  answer: string,
  options: JudgeCallOptions,
  judgeModel: Model,
  budget: JudgeBudget,
): Promise<SoloJudging> => {
  const prompt = soloJudgePrompt(problem, blindText(answer));
  const schema = soloJudgementSchema(problem);
  const estimate = estimateInput(
    { system: SOLO_JUDGE_SYSTEM, prompt, schema },
    judgeModel.charsPerToken,
  );
  const fit = fitCall({
    pricing: judgeModel.pricing,
    inputTokens: estimate.tokens,
    maxOutputTokens: options.maxOutputTokens,
    remainingUsd: budget.remainingUsd,
  });
  if (!fit.fits) {
    return {
      judgement: null,
      skipped: `$${budget.remainingUsd.toFixed(4)} left does not cover the judge call ($${fit.worstCaseUsd.toFixed(4)})`,
      usage: zeroUsage(),
      fits: false,
      error: null,
    };
  }
  if (options.whole === true && fit.shrunk) {
    return {
      judgement: null,
      skipped: `$${budget.remainingUsd.toFixed(4)} left does not cover the judge call at its whole allowance of ${String(options.maxOutputTokens)} output tokens`,
      usage: zeroUsage(),
      fits: false,
      error: null,
    };
  }
  const response = await judgeModel.generateObject({
    schema,
    system: SOLO_JUDGE_SYSTEM,
    prompt,
    maxOutputTokens: fit.maxOutputTokens,
    tags: options.tags,
  });
  if (!response.ok) {
    const usage = response.error.kind === 'invalid_output' ? response.error.usage : zeroUsage();
    budget.charge(usage.costUsd);
    return {
      judgement: null,
      skipped: response.error.kind,
      usage,
      fits: true,
      error: response.error.kind,
    };
  }
  budget.charge(response.value.usage.costUsd);
  return {
    judgement: response.value.object,
    skipped: null,
    usage: response.value.usage,
    fits: true,
    error: null,
  };
};
