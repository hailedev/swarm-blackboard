import type { ResolvedEvalModels, RunProfile } from '@team/core';

import type { CriterionScore } from './judge';
import type { PassResult, ProblemResult } from './pass';

// The committed report (docs/PLAN.md §6, Phase 5): what ran, what it cost, how the arms
// scored, and the honesty notes a reader needs to weigh ten judged pairs. Three pairs are
// written out in full for the human spot-check: the swarm's widest win, the baseline's,
// and the closest call.

export interface ReportMeta {
  label: string;
  profile: RunProfile;
  evalModels: ResolvedEvalModels;
  commit: string | null;
  /** The resolved model ids actually called, for the header. */
  baselineModelId: string;
  judgeModelId: string;
}

const usd = (value: number): string => `$${value.toFixed(4)}`;
const pct = (value: number | null): string => (value === null ? '—' : `${value.toFixed(1)}%`);
const signed = (value: number | null): string =>
  value === null ? '—' : `${value >= 0 ? '+' : ''}${value.toFixed(1)}`;
const cell = (text: string): string => text.replace(/\|/g, '\\|').replace(/\n/g, ' ');

const modelLine = (label: string, model: { alias: string; provider: string; model: string }) =>
  `- ${label}: \`${model.alias}\` (${model.provider}/${model.model})`;

export const renderReport = (pass: PassResult, meta: ReportMeta): string => {
  const lines: string[] = [];
  lines.push(`# Eval pass: ${meta.label}`, '');
  lines.push(`- Pass id: \`${pass.passId}\``);
  lines.push(`- Started: ${pass.startedAt}; ended: ${pass.endedAt}`);
  lines.push(`- Controller commit: ${meta.commit === null ? 'unknown' : `\`${meta.commit}\``}`);
  lines.push(`- Swarm profile: \`${meta.profile.name}\``);
  for (const role of ['planner', 'researcher', 'solver', 'critic', 'synthesizer'] as const) {
    lines.push(`  ${modelLine(role, meta.profile.roles[role])}`);
  }
  lines.push(
    `  - fallback: ${meta.profile.fallback === null ? 'none' : `\`${meta.profile.fallback.alias}\``}`,
  );
  lines.push(modelLine('Baseline', meta.evalModels.baseline) + ` → ${meta.baselineModelId}`);
  lines.push(modelLine('Judge', meta.evalModels.judge) + ` → ${meta.judgeModelId}`);
  lines.push(
    `- Caps: pass ${usd(pass.options.capUsd)}; each swarm run and each baseline call capped at ${usd(pass.options.runCapUsd)}, the same budget for both arms`,
  );
  lines.push(
    `- Judging: ${pass.options.judgeOrders === 2 ? 'both orders per pair' : 'one random order per pair'}; blind to the arm`,
  );
  lines.push(`- Spent: ${usd(pass.spentUsd)} over ${String(pass.results.length)} problems`);
  if (pass.stopped !== null) {
    lines.push(
      `- **Stopped early** before \`${pass.stopped.beforeProblem}\`: ${
        pass.stopped.reason === 'pass_cap'
          ? `the pass cap was reached (${usd(pass.stopped.remainingUsd)} left)`
          : `the month's budget is spent (${usd(pass.stopped.spentUsd)} of ${usd(pass.stopped.limitUsd)})`
      }`,
    );
  }
  lines.push('');

  const a = pass.aggregate;
  lines.push('## Result', '');
  lines.push('| | Swarm | Baseline |', '|---|---|---|');
  lines.push(`| Mean rubric score | ${pct(a.swarmMean)} | ${pct(a.baselineMean)} |`);
  lines.push(
    `| Judged pairs | ${String(a.judged)} of ${String(a.problems)} | |`,
    `| Wins / ties / losses (swarm) | ${String(a.wins)} / ${String(a.ties)} / ${String(a.losses)} | |`,
    `| Mean delta (swarm − baseline) | ${signed(a.meanDelta)} points | |`,
    `| Judge consistency (spread between orders) | ${a.consistency === null ? '—' : `${a.consistency.toFixed(1)} points`} | |`,
    `| First-shown answer preferred | ${String(a.firstShownPreferred.count)} of ${String(a.firstShownPreferred.of)} decided judgements | |`,
  );
  lines.push('');
  lines.push(
    `With ${String(a.judged)} judged pairs, a difference smaller than the judge's own consistency figure is not evidence of anything. Both arms had the same cap; the swarm's spend includes every traced call of its runs.`,
    '',
  );

  lines.push('## Per problem', '');
  lines.push(
    '| Problem | Run | Rounds | End | Swarm cost | Baseline cap → cost | Baseline tokens used/allowed (words asked) | Thinking tokens swarm / baseline / judge | Swarm | Baseline | Δ | Winner | Notes |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|',
  );
  for (const r of pass.results) lines.push(problemRow(r));
  lines.push('');
  lines.push(thinkingLine(pass), '');

  const notes = honestyNotes(pass);
  if (notes.length > 0) {
    lines.push('## Notes', '');
    for (const note of notes) lines.push(`- ${note}`);
    lines.push('');
  }

  lines.push('## Pairs written out', '');
  const pairs = selectPairs(pass);
  if (pairs.length === 0) lines.push('No pair was judged.');
  for (const { why, result } of pairs) lines.push(`- \`pairs/${result.problem.id}.md\` — ${why}`);
  lines.push('');
  return lines.join('\n');
};

const problemRow = (r: ProblemResult): string => {
  const swarm = r.swarm;
  const notes: string[] = [];
  if (r.swarmError !== null) notes.push(`swarm failed: ${r.swarmError}`);
  if (swarm !== null && swarm.answer === null) notes.push('no synthesis');
  if (r.baselineCached) notes.push('baseline cached');
  if (r.baselineSkipped !== null) notes.push(`baseline skipped: ${r.baselineSkipped}`);
  for (const skipped of r.judgeSkipped) notes.push(`judge: ${skipped}`);
  if (r.baseline?.truncated === true) notes.push('baseline truncated at its allowance');
  const baselineCell =
    r.baseline === null ? '—' : `${usd(r.baseline.capUsd)} → ${usd(r.baseline.usage.costUsd)}`;
  const tokensCell = r.baseline === null ? '—' : baselineTokens(r.baseline);
  const thinking = `${swarm === null ? '—' : thinkingOf(swarm.usage)} / ${r.baseline === null ? '—' : thinkingOf(r.baseline.usage)} / ${thinkingOf(r.judgeUsage)}`;
  return `| ${r.problem.id} | ${swarm === null ? '—' : `\`${swarm.runId}\``} | ${swarm === null ? '—' : String(swarm.rounds)} | ${swarm === null ? '—' : `${swarm.status}/${swarm.reason}`} | ${swarm === null ? '—' : usd(swarm.costUsd)} | ${baselineCell} | ${tokensCell} | ${thinking} | ${pct(r.scores.swarm)} | ${pct(r.scores.baseline)} | ${signed(r.scores.delta)} | ${r.scores.winner ?? '—'} | ${cell(notes.join('; '))} |`;
};

/** "1,234 of 5,678": the thinking part of an arm's output tokens. */
const thinkingOf = (usage: { reasoningTokens: number; outputTokens: number }): string =>
  `${String(usage.reasoningTokens)} of ${String(usage.outputTokens)}`;

/** The pass's thinking tokens per arm, so the cost of hidden reasoning is in the open (ADR-0013). */
export const thinkingLine = (pass: PassResult): string => {
  const sum = (
    pick: (r: ProblemResult) => { reasoningTokens: number; outputTokens: number } | null,
  ) =>
    pass.results.reduce(
      (total, r) => {
        const u = pick(r);
        return u === null
          ? total
          : {
              reasoningTokens: total.reasoningTokens + u.reasoningTokens,
              outputTokens: total.outputTokens + u.outputTokens,
            };
      },
      { reasoningTokens: 0, outputTokens: 0 },
    );
  const swarm = sum((r) => r.swarm?.usage ?? null);
  const baseline = sum((r) => (r.baselineCached ? null : (r.baseline?.usage ?? null)));
  const judge = sum((r) => r.judgeUsage);
  return `Thinking tokens, as a share of output tokens: swarm ${thinkingOf(swarm)}, baseline ${thinkingOf(baseline)} (uncached calls only), judge ${thinkingOf(judge)}.`;
};

/** "1,234/2,000 (≈1,300 words)", with a flag when the answer ran into its allowance. */
const baselineTokens = (b: NonNullable<ProblemResult['baseline']>): string =>
  `${String(b.usage.outputTokens)}/${String(b.maxOutputTokens)} (${String(b.wordBudget)} words)${b.truncated ? ' **truncated**' : ''}`;

/** Things a reader must know before trusting the table. */
export const honestyNotes = (pass: PassResult): string[] => {
  const notes: string[] = [];
  const truncated = pass.results.filter((r) => r.baseline?.truncated === true);
  if (truncated.length > 0) {
    notes.push(
      `${String(truncated.length)} baseline answer${truncated.length === 1 ? '' : 's'} used the whole output allowance (${truncated.map((r) => r.problem.id).join(', ')}) and probably lost ${truncated.length === 1 ? 'its' : 'their'} ending; the judge scored what arrived.`,
    );
  }
  const runCap = pass.options.runCapUsd;
  const drifted = pass.results.filter(
    (r) =>
      r.baselineCached &&
      r.baseline !== null &&
      runCap > 0 &&
      Math.abs(r.baseline.capUsd - runCap) / runCap > 0.25,
  );
  for (const r of drifted) {
    if (r.baseline === null) continue;
    notes.push(
      `\`${r.problem.id}\`: the cached baseline was capped at ${usd(r.baseline.capUsd)} (about ${String(r.baseline.wordBudget)} words) on an earlier pass; this pass's cap is ${usd(runCap)}, so the arms did not share one budget. Pass \`--refresh-baselines\` to redo it.`,
    );
  }
  const noAnswer = pass.results.filter((r) => r.swarm !== null && r.swarm.answer === null);
  if (noAnswer.length > 0) {
    notes.push(
      `${String(noAnswer.length)} swarm run${noAnswer.length === 1 ? '' : 's'} ended without a synthesis (${noAnswer.map((r) => r.problem.id).join(', ')}); the swarm scores 0 there and the pair was not judged.`,
    );
  }
  const unjudged = pass.results.filter(
    (r) => r.judgements.length === 0 && r.judgeSkipped.length > 0,
  );
  if (unjudged.length > noAnswer.length) {
    notes.push(
      'Some pairs were not judged for the reason in their row; the means cover judged pairs only.',
    );
  }
  const oneOrder = pass.results.filter(
    (r) => pass.options.judgeOrders === 2 && r.judgements.length === 1,
  );
  if (oneOrder.length > 0) {
    notes.push(
      `${String(oneOrder.length)} pair${oneOrder.length === 1 ? ' was' : 's were'} judged in one order only, so their consistency figure is missing.`,
    );
  }
  return notes;
};

export interface SelectedPair {
  why: string;
  result: ProblemResult;
}

/** The swarm's widest win, the baseline's widest win and the closest call, when they exist. */
export const selectPairs = (pass: PassResult): SelectedPair[] => {
  const judged = pass.results.filter((r) => r.scores.delta !== null && r.judgements.length > 0);
  if (judged.length === 0) return [];
  const byDelta = [...judged].sort((x, y) => (y.scores.delta ?? 0) - (x.scores.delta ?? 0));
  const picks: SelectedPair[] = [];
  const add = (why: string, result: ProblemResult | undefined): void => {
    if (result !== undefined && !picks.some((p) => p.result === result))
      picks.push({ why, result });
  };
  add("the swarm's widest win", byDelta[0]);
  add("the baseline's widest win", byDelta.at(-1));
  add(
    'the closest call',
    [...judged].sort((x, y) => Math.abs(x.scores.delta ?? 0) - Math.abs(y.scores.delta ?? 0))[0],
  );
  return picks;
};

const scoreTable = (
  rubric: ProblemResult['problem']['rubric'],
  swarm: Record<string, CriterionScore>,
  baseline: Record<string, CriterionScore>,
): string[] => [
  '| Criterion | Weight | Swarm | Baseline |',
  '|---|---|---|---|',
  ...rubric.map(
    (c) =>
      `| ${c.id} | ${String(c.weight)} | ${String(swarm[c.id]?.score ?? '—')} — ${cell(swarm[c.id]?.reason ?? '')} | ${String(baseline[c.id]?.score ?? '—')} — ${cell(baseline[c.id]?.reason ?? '')} |`,
  ),
];

export const renderPair = (result: ProblemResult, why: string): string => {
  const lines: string[] = [];
  lines.push(
    `# ${result.problem.title}`,
    '',
    `Chosen as ${why}. Problem \`${result.problem.id}\`.`,
    '',
  );
  lines.push('## Problem', '', result.problem.statement, '');
  if (result.problem.constraints.length > 0) {
    lines.push('### Constraints', '', ...result.problem.constraints.map((c) => `- ${c}`), '');
  }
  if (result.problem.successCriteria.length > 0) {
    lines.push(
      '### Success criteria',
      '',
      ...result.problem.successCriteria.map((c) => `- ${c}`),
      '',
    );
  }
  lines.push(
    '## Swarm answer',
    '',
    result.swarm === null
      ? '_The swarm did not run._'
      : `_Run \`${result.swarm.runId}\`, ${String(result.swarm.rounds)} rounds, ${result.swarm.status}/${result.swarm.reason}, ${usd(result.swarm.costUsd)}${result.swarm.confidence === null ? '' : `, confidence ${result.swarm.confidence.toFixed(2)}`}._`,
    '',
    result.swarm?.answer ?? '_No synthesis._',
    '',
  );
  lines.push(
    '## Baseline answer',
    '',
    result.baseline === null
      ? '_No baseline answer._'
      : `_${result.baseline.modelId}, asked for about ${String(result.baseline.wordBudget)} words, used ${String(result.baseline.usage.outputTokens)} of ${String(result.baseline.maxOutputTokens)} output tokens allowed under a ${usd(result.baseline.capUsd)} cap, cost ${usd(result.baseline.usage.costUsd)}${result.baseline.truncated ? ', truncated at the allowance' : ''}${result.baselineCached ? ', cached from an earlier pass' : ''}. Board handles are shown here; the judge saw the answers with them removed._`,
    '',
    result.baseline?.answer ?? '',
    '',
  );
  lines.push(
    '## Judgements',
    '',
    `Swarm ${pct(result.scores.swarm)}, baseline ${pct(result.scores.baseline)}, winner ${result.scores.winner ?? '—'}.`,
    '',
  );
  for (const [index, j] of result.judgements.entries()) {
    lines.push(
      `### Order ${String(index + 1)}: A = ${j.order.A}, B = ${j.order.B}; preferred ${j.preferred}`,
      '',
      ...scoreTable(result.problem.rubric, j.swarm, j.baseline),
      '',
      j.note === '' ? '' : `> ${j.note}`,
      '',
    );
  }
  for (const skipped of result.judgeSkipped) lines.push(`- Not judged: ${skipped}`);
  return lines.join('\n');
};
