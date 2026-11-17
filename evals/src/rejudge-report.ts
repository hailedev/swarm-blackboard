import { pairwiseHistory, type PairwiseScore, type PriorPass } from './history';
import type { Problem } from './problems';
import { refKey, type AnswerRef, type RejudgeResult, type SourcedAnswer } from './rejudge';
import { wordCount } from './words';

// The report of a judge-only session (rejudge.ts): what was judged again and what it cost,
// and then, per problem, every answer with its solo score beside the pairwise scores it
// has received so far and the answer it received each of them against.

export interface RejudgeMeta {
  label: string;
  commit: string | null;
  judge: { alias: string; modelId: string };
  /** The model id behind each baseline alias the session named. */
  baselines: Record<string, string>;
}

const usd = (value: number): string => `$${value.toFixed(4)}`;
const pct = (value: number | null): string => (value === null ? '—' : `${value.toFixed(1)}%`);
const cell = (text: string): string => text.replace(/\|/g, '\\|').replace(/\n/g, ' ');

/** How a row names an answer: "the swarm answer of step2b", "the sonnet baseline (claude-…)". */
export const describeRef = (ref: AnswerRef, meta: RejudgeMeta): string =>
  ref.kind === 'swarm'
    ? `swarm answer of ${ref.pass}`
    : `${ref.alias} baseline (${meta.baselines[ref.alias] ?? 'unknown model'})`;

export interface AnswerRow {
  ref: AnswerRef;
  answer: SourcedAnswer | null;
  solo: number | null;
  /** Why there is no solo score, when there is none. */
  soloNote: string | null;
  /** Earlier passes first, then this session's. */
  pairwise: PairwiseScore[];
}

/**
 * One row per answer the session was pointed at, for one problem: its solo score and every
 * pairwise score the same text has had, from earlier passes and from this session.
 */
export const answerRows = (
  result: RejudgeResult,
  passes: readonly PriorPass[],
  problemId: string,
  label: string,
): AnswerRow[] => {
  const rows = new Map<string, AnswerRow>();
  const rowFor = (ref: AnswerRef, answer: SourcedAnswer | null): AnswerRow => {
    const key = refKey(ref);
    const existing = rows.get(key);
    if (existing !== undefined) {
      if (existing.answer === null && answer !== null) {
        existing.answer = answer;
        existing.pairwise = pairwiseHistory(passes, problemId, answer.text);
      }
      return existing;
    }
    const row: AnswerRow = {
      ref,
      answer,
      solo: null,
      soloNote: null,
      pairwise: answer === null ? [] : pairwiseHistory(passes, problemId, answer.text),
    };
    rows.set(key, row);
    return row;
  };
  for (const solo of result.solo.filter((s) => s.problemId === problemId)) {
    const row = rowFor(solo.ref, solo.answer);
    row.solo = solo.percent;
    row.soloNote = solo.percent === null ? solo.skipped : null;
  }
  for (const pair of result.pairs.filter((p) => p.problemId === problemId)) {
    const swarm = rowFor({ kind: 'swarm', pass: pair.pass }, pair.swarm);
    const baseline = rowFor({ kind: 'baseline', alias: pair.alias }, pair.baseline);
    if (pair.judgements.length === 0) continue;
    if (pair.scores.swarm !== null) {
      swarm.pairwise.push({
        pass: label,
        score: pair.scores.swarm,
        opponent: `the ${pair.baseline?.origin ?? pair.alias} baseline`,
      });
    }
    if (pair.scores.baseline !== null) {
      baseline.pairwise.push({
        pass: label,
        score: pair.scores.baseline,
        opponent: `the swarm answer of ${pair.pass}`,
      });
    }
  }
  return [...rows.values()];
};

export const renderRejudgeReport = (
  result: RejudgeResult,
  meta: RejudgeMeta,
  problems: readonly Problem[],
  passes: readonly PriorPass[],
): string => {
  const lines: string[] = [];
  lines.push(`# Judge-only session: ${meta.label}`, '');
  lines.push(`- Session id: \`${result.sessionId}\``);
  lines.push(`- Started: ${result.startedAt}; ended: ${result.endedAt}`);
  lines.push(`- Commit: ${meta.commit === null ? 'unknown' : `\`${meta.commit}\``}`);
  lines.push(`- Judge: \`${meta.judge.alias}\` → ${meta.judge.modelId}`);
  lines.push(
    '- No swarm ran: every answer judged here already existed, bar the baselines listed under "Baselines made".',
  );
  lines.push(`- Spent: ${usd(result.spentUsd)} of a ${usd(result.capUsd)} cap`);
  lines.push('');

  if (result.made.length > 0) {
    lines.push('## Baselines made', '');
    lines.push(
      'A baseline the session needed and the cache did not hold, or held only as an answer under half its word budget. Made with the baseline’s length guard: under half its word budget it is asked for once more, and one that is still short is void and not judged.',
      '',
    );
    lines.push(
      '| Problem | Baseline | Words / asked | Attempts | Cost | |',
      '|---|---|---|---|---|---|',
    );
    for (const made of result.made) {
      const words = wordCount(made.record.answer);
      lines.push(
        `| ${made.problemId} | \`${made.alias}\` (${made.record.modelId}) | ${String(words)} / ${String(made.record.wordBudget)} | ${String(made.record.attempts)} | ${usd(made.costUsd)} | ${made.record.void ? '**void**' : 'kept and cached'} |`,
      );
    }
    lines.push('');
  }

  if (result.pairs.length > 0) {
    lines.push('## Pairwise', '');
    lines.push(
      'Two answers side by side, blind to which arm wrote which, as a pass judges a pair; each score is the mean over the orders judged.',
      '',
    );
    lines.push(
      '| Problem | Swarm answer | Baseline | Swarm | Baseline | Δ | Preferred | Spread between orders | Notes |',
      '|---|---|---|---|---|---|---|---|---|',
    );
    for (const pair of result.pairs) {
      lines.push(
        `| ${pair.problemId} | of ${pair.pass} | \`${pair.alias}\` | ${pct(pair.scores.swarm)} | ${pct(pair.scores.baseline)} | ${pair.scores.delta === null ? '—' : `${pair.scores.delta >= 0 ? '+' : ''}${pair.scores.delta.toFixed(1)}`} | ${pair.scores.winner ?? '—'} | ${pair.scores.consistency === null ? '—' : `${pair.scores.consistency.toFixed(1)} points`} | ${cell(pair.skipped.join('; '))} |`,
      );
    }
    lines.push('');
  }

  lines.push('## Per problem: solo beside pairwise', '');
  lines.push(
    'Solo: the answer alone against the rubric, nothing beside it, one call. Pairwise so far: every score the same text has received with another answer beside it, with that other answer and the pass that gave it; a score from this session is marked with its label. A cached baseline is the same text in every pass that reused it.',
    '',
  );
  for (const problem of problems) {
    lines.push(`### ${problem.id}`, '');
    lines.push('| Answer | Words / asked | Solo | Pairwise so far |', '|---|---|---|---|');
    for (const row of answerRows(result, passes, problem.id, meta.label)) {
      const words =
        row.answer === null
          ? '—'
          : `${String(row.answer.words)} / ${row.answer.wordBudget === null ? '—' : String(row.answer.wordBudget)}`;
      const solo =
        row.solo !== null ? pct(row.solo) : row.soloNote === null ? '—' : `— (${row.soloNote})`;
      const pairwise =
        row.pairwise.length === 0
          ? 'none'
          : row.pairwise.map((p) => `${pct(p.score)} beside ${p.opponent} (${p.pass})`).join('; ');
      lines.push(
        `| ${describeRef(row.ref, meta)} | ${words} | ${cell(solo)} | ${cell(pairwise)} |`,
      );
    }
    lines.push('');
  }

  const notScored = result.solo.filter((s) => s.percent === null);
  const unjudged = result.pairs.filter((p) => p.judgements.length === 0);
  if (notScored.length > 0 || unjudged.length > 0) {
    lines.push('## Not judged', '');
    for (const pair of unjudged) {
      lines.push(
        `- \`${pair.problemId}\`, pairwise, ${pair.pass} beside \`${pair.alias}\`: ${pair.skipped.join('; ')}`,
      );
    }
    for (const solo of notScored) {
      lines.push(
        `- \`${solo.problemId}\`, solo, ${refKey(solo.ref)}: ${solo.skipped ?? 'no judgement'}`,
      );
    }
    lines.push('');
  }
  return lines.join('\n');
};
