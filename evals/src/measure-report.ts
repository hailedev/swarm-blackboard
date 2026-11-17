import {
  answerId,
  armRef,
  sameArm,
  type AnswerKey,
  type AnsweredAnswer,
  type Arm,
  type Manifest,
  type MeasuredAnswer,
  type ScoredRecord,
  type ScoreRecord,
} from './measure-store';
import { answerKeys } from './measure';
import type { Problem } from './problems';

// The report of a measurement (measure.ts): pure arithmetic over the records on disk, then
// markdown. It can be rendered at any time: before any score exists it is the account of
// stage 1 (what was made, what it cost, what is void or failed), and the score sections
// fill in as scores arrive.
//
// How a number is built, everywhere below:
//   an answer's score        = the mean of the scores it was given (two, by default);
//   an arm's score on a problem = the mean over its answers on it (three runs for a swarm
//                              arm, the one call for a call arm);
//   an arm's mean            = the mean of those over the problems.
// A void answer has no score and is left out, as a pass leaves a void baseline out.

/** The three problems every change of Phase 5 was tried on (evals/README.md); the rest were held out. */
export const DEVELOPMENT_SET: readonly string[] = [
  'api-rate-limiting',
  'oidc-migration',
  'teen-reading-programme',
];

// ── Arithmetic ───────────────────────────────────────────────────────────────────────────

export const mean = (values: readonly number[]): number | null =>
  values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length;

/** The sample standard deviation (n − 1); null with fewer than two values. */
export const sampleSd = (values: readonly number[]): number | null => {
  const m = mean(values);
  if (m === null || values.length < 2) return null;
  return Math.sqrt(values.reduce((sum, v) => sum + (v - m) ** 2, 0) / (values.length - 1));
};

export const median = (values: readonly number[]): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const upper = sorted[mid] ?? 0;
  return sorted.length % 2 === 1 ? upper : ((sorted[mid - 1] ?? 0) + upper) / 2;
};

const range = (values: readonly number[]): number | null =>
  values.length < 2 ? null : Math.max(...values) - Math.min(...values);

export interface Spread {
  n: number;
  mean: number | null;
  sd: number | null;
  min: number | null;
  max: number | null;
}

export const spreadOf = (values: readonly number[]): Spread => ({
  n: values.length,
  mean: mean(values),
  sd: sampleSd(values),
  min: values.length === 0 ? null : Math.min(...values),
  max: values.length === 0 ? null : Math.max(...values),
});

// ── The summary ──────────────────────────────────────────────────────────────────────────

export interface ScoredAnswer {
  run: number;
  /** In the order they were given. */
  scores: number[];
  /** The answer's score: the mean of `scores`. */
  mean: number;
}

export interface ArmCell {
  problemId: string;
  /** The answers of the arm on the problem that have at least one score. */
  answers: ScoredAnswer[];
  /** The arm's score on the problem; null when no answer of it was scored. */
  mean: number | null;
  min: number | null;
  max: number | null;
  /** Over the answers' scores: the run-to-run spread, null with fewer than two answers. */
  sd: number | null;
  range: number | null;
}

export interface ArmCounts {
  expected: number;
  answered: number;
  void: number;
  failed: number;
  /** Not on disk at all: never attempted, or not reached by the cap. */
  missing: number;
  spentUsd: number;
  /** Words of the answered answers. */
  words: { min: number; median: number; max: number } | null;
}

export interface SwarmCounts {
  /** How the runs that produced an answer or a void ended, by reason. */
  endings: Record<string, number>;
  rounds: { min: number; max: number } | null;
  /** Answers that are the run's final write-up, and answers that are a draft in its place. */
  final: number;
  drafts: number;
  /** Write-ups asked for a second time, by why. */
  retriedShort: number;
  retriedLeak: number;
  /** Answers kept that still hold a sentence they should not. */
  leaking: number;
  meanMinutes: number | null;
}

export interface ArmSummary {
  arm: Arm;
  counts: ArmCounts;
  /** Null for a call arm. */
  swarm: SwarmCounts | null;
  /** One per problem of the measurement, in its order. */
  cells: ArmCell[];
  overProblems: Spread;
  development: Spread;
  heldOut: Spread;
  /** Null for a call arm: it has one answer per problem. */
  runToRun: {
    /** Problems with at least two scored runs. */
    problems: number;
    /** The root of the mean within-problem variance. */
    pooledSd: number | null;
    meanRange: number | null;
    largest: { problemId: string; range: number } | null;
  } | null;
  /** The judge against itself: |score 1 − score 2| over the arm's answers scored at least twice. */
  judge: { answers: number; meanSpread: number | null; largest: number | null };
  ceiling: {
    /** Answers with every score at 100 %, of the answers scored. */
    answersAt100: number;
    answersScored: number;
    /** Single scores at 100 %, of all scores. */
    scoresAt100: number;
    scores: number;
  };
}

export interface ComparisonRow {
  problemId: string;
  /** The call's scores, and their mean. */
  callScores: number[];
  call: number | null;
  /** Each scored run's score, in run order. */
  runs: { run: number; score: number }[];
  swarm: number | null;
  /** swarm − call. */
  delta: number | null;
  runsAbove: number;
}

export interface Comparison {
  swarm: Arm;
  call: Arm;
  rows: ComparisonRow[];
  /** Over the problems where both have a score. */
  n: number;
  meanDelta: number | null;
  sdDelta: number | null;
  /** The standard error of the mean difference: sd / √n. */
  seDelta: number | null;
  ahead: number;
  behind: number;
  level: number;
  /** Runs above the call, of the runs scored, over all problems. */
  runsAbove: number;
  runsScored: number;
}

export interface Flagged {
  id: string;
  note: string;
}

export interface MeasureSummary {
  arms: ArmSummary[];
  comparisons: Comparison[];
  judge: { answers: number; meanSpread: number | null; largest: number | null };
  answers: { expected: number; answered: number; void: number; failed: number; missing: number };
  scores: { expected: number; scored: number; failed: number; missing: number };
  spent: { generateUsd: number; scoreUsd: number };
  voids: Flagged[];
  failures: Flagged[];
  scoreFailures: Flagged[];
  drafts: Flagged[];
  leaking: { id: string; sentences: string[] }[];
  truncated: string[];
  /** Answers asked for another length than the measurement's. */
  offBudget: Flagged[];
  /** Answers that took more than one invocation. */
  retried: Flagged[];
  /** The commits the answers were made on; more than one is said in the report. */
  commits: string[];
}

const scoredOf = (records: readonly ScoreRecord[]): ScoredRecord[] =>
  records.filter((r): r is ScoredRecord => r.outcome === 'scored');

export const summarise = (
  manifest: Manifest,
  answers: readonly MeasuredAnswer[],
  scores: readonly ScoreRecord[],
): MeasureSummary => {
  const answerOf = new Map(answers.map((a) => [answerId(a), a]));
  const scoresOf = new Map<string, ScoredRecord[]>();
  for (const score of scoredOf(scores)) {
    const id = answerId(score);
    scoresOf.set(id, [...(scoresOf.get(id) ?? []), score]);
  }
  for (const list of scoresOf.values()) list.sort((a, b) => a.score - b.score);

  const scoredAnswer = (key: AnswerKey): ScoredAnswer | null => {
    if (answerOf.get(answerId(key))?.outcome !== 'answered') return null;
    const percents = (scoresOf.get(answerId(key)) ?? []).map((s) => s.percent);
    const m = mean(percents);
    return m === null ? null : { run: key.run, scores: percents, mean: m };
  };

  const arms = manifest.arms.map((arm): ArmSummary => {
    const keys = answerKeys(manifest.problemIds, [arm], manifest.runs);
    const records = keys.map((key) => answerOf.get(answerId(key)));
    const answered = records.filter((r): r is AnsweredAnswer => r?.outcome === 'answered');
    const words = answered.map((r) => r.words);
    const counts: ArmCounts = {
      expected: keys.length,
      answered: answered.length,
      void: records.filter((r) => r?.outcome === 'void').length,
      failed: records.filter((r) => r?.outcome === 'failed').length,
      missing: records.filter((r) => r === undefined).length,
      spentUsd: records.reduce((sum, r) => sum + (r?.spentUsd ?? 0), 0),
      words:
        words.length === 0
          ? null
          : { min: Math.min(...words), median: median(words) ?? 0, max: Math.max(...words) },
    };

    let swarm: SwarmCounts | null = null;
    if (arm.kind === 'swarm') {
      const details = records.flatMap((r) =>
        r !== undefined && r.outcome !== 'failed' && r.detail.kind === 'swarm' ? [r.detail] : [],
      );
      const kept = answered.flatMap((r) => (r.detail.kind === 'swarm' ? [r.detail] : []));
      const endings: Record<string, number> = {};
      for (const detail of details) endings[detail.reason] = (endings[detail.reason] ?? 0) + 1;
      const rounds = details.map((d) => d.rounds);
      swarm = {
        endings,
        rounds: rounds.length === 0 ? null : { min: Math.min(...rounds), max: Math.max(...rounds) },
        final: kept.filter((d) => d.stage === 'final').length,
        drafts: kept.filter((d) => d.stage !== 'final').length,
        retriedShort: details.filter((d) => d.writeUp?.retriedFor.includes('short')).length,
        retriedLeak: details.filter((d) => d.writeUp?.retriedFor.includes('leak')).length,
        leaking: kept.filter((d) => (d.writeUp?.leaks.length ?? 0) > 0).length,
        meanMinutes: ((ms) => (ms === null ? null : ms / 60_000))(
          mean(details.map((d) => d.elapsedMs)),
        ),
      };
    }

    const cells = manifest.problemIds.map((problemId): ArmCell => {
      const scored = answerKeys([problemId], [arm], manifest.runs)
        .map(scoredAnswer)
        .filter((a): a is ScoredAnswer => a !== null);
      const means = scored.map((a) => a.mean);
      const spread = spreadOf(means);
      return {
        problemId,
        answers: scored,
        mean: spread.mean,
        min: spread.min,
        max: spread.max,
        sd: spread.sd,
        range: range(means),
      };
    });
    const cellMeans = (keep: (problemId: string) => boolean): number[] =>
      cells.flatMap((cell) => (cell.mean !== null && keep(cell.problemId) ? [cell.mean] : []));

    const withRuns = cells.filter((cell) => cell.sd !== null && cell.range !== null);
    const ranges = withRuns.map((cell) => cell.range ?? 0);
    const widest = withRuns.reduce<ArmCell | null>(
      (best, cell) => (best === null || (cell.range ?? 0) > (best.range ?? 0) ? cell : best),
      null,
    );
    const pooledVariance = mean(withRuns.map((cell) => (cell.sd ?? 0) ** 2));

    const all = cells.flatMap((cell) => cell.answers);
    const twice = all.filter((a) => a.scores.length >= 2);
    const spreads = twice.map((a) => Math.max(...a.scores) - Math.min(...a.scores));
    const single = all.flatMap((a) => a.scores);

    return {
      arm,
      counts,
      swarm,
      cells,
      overProblems: spreadOf(cellMeans(() => true)),
      development: spreadOf(cellMeans((id) => DEVELOPMENT_SET.includes(id))),
      heldOut: spreadOf(cellMeans((id) => !DEVELOPMENT_SET.includes(id))),
      runToRun:
        arm.kind === 'call'
          ? null
          : {
              problems: withRuns.length,
              pooledSd: pooledVariance === null ? null : Math.sqrt(pooledVariance),
              meanRange: mean(ranges),
              largest:
                widest === null ? null : { problemId: widest.problemId, range: widest.range ?? 0 },
            },
      judge: {
        answers: twice.length,
        meanSpread: mean(spreads),
        largest: spreads.length === 0 ? null : Math.max(...spreads),
      },
      ceiling: {
        answersAt100: all.filter((a) => a.scores.every((s) => s >= 100)).length,
        answersScored: all.length,
        scoresAt100: single.filter((s) => s >= 100).length,
        scores: single.length,
      },
    };
  });

  const armSummary = (arm: Arm): ArmSummary | undefined => arms.find((a) => sameArm(a.arm, arm));
  const comparisons = manifest.comparisons.flatMap((pair): Comparison[] => {
    const swarm = armSummary(pair.swarm);
    const call = armSummary(pair.call);
    if (swarm === undefined || call === undefined) return [];
    const rows = manifest.problemIds.map((problemId, index): ComparisonRow => {
      const callCell = call.cells[index];
      const swarmCell = swarm.cells[index];
      const callScore = callCell?.mean ?? null;
      const runs = (swarmCell?.answers ?? []).map((a) => ({ run: a.run, score: a.mean }));
      const swarmScore = swarmCell?.mean ?? null;
      return {
        problemId,
        callScores: callCell?.answers[0]?.scores ?? [],
        call: callScore,
        runs,
        swarm: swarmScore,
        delta: callScore === null || swarmScore === null ? null : swarmScore - callScore,
        runsAbove: callScore === null ? 0 : runs.filter((r) => r.score > callScore).length,
      };
    });
    const both = rows.filter((row) => row.delta !== null);
    const deltas = both.map((row) => row.delta ?? 0);
    const sd = sampleSd(deltas);
    return [
      {
        swarm: pair.swarm,
        call: pair.call,
        rows,
        n: both.length,
        meanDelta: mean(deltas),
        sdDelta: sd,
        seDelta: sd === null ? null : sd / Math.sqrt(deltas.length),
        ahead: deltas.filter((d) => d > 0).length,
        behind: deltas.filter((d) => d < 0).length,
        level: deltas.filter((d) => d === 0).length,
        runsAbove: both.reduce((sum, row) => sum + row.runsAbove, 0),
        runsScored: both.reduce((sum, row) => sum + row.runs.length, 0),
      },
    ];
  });

  const expectedKeys = answerKeys(manifest.problemIds, manifest.arms, manifest.runs);
  const expected = expectedKeys.map((key) => ({ key, record: answerOf.get(answerId(key)) }));
  const answered = expected.flatMap(({ record }) =>
    record?.outcome === 'answered' ? [record] : [],
  );
  const scoreRecordOf = new Map(scores.map((s) => [`${answerId(s)}--s${String(s.score)}`, s]));
  const expectedScores = answered.flatMap((a) =>
    Array.from({ length: manifest.scoresPerAnswer }, (_, i) =>
      scoreRecordOf.get(`${answerId(a)}--s${String(i + 1)}`),
    ),
  );
  const allSpreads = arms.flatMap((a) =>
    a.cells.flatMap((cell) =>
      cell.answers
        .filter((answer) => answer.scores.length >= 2)
        .map((answer) => Math.max(...answer.scores) - Math.min(...answer.scores)),
    ),
  );

  return {
    arms,
    comparisons,
    judge: {
      answers: allSpreads.length,
      meanSpread: mean(allSpreads),
      largest: allSpreads.length === 0 ? null : Math.max(...allSpreads),
    },
    answers: {
      expected: expected.length,
      answered: answered.length,
      void: expected.filter(({ record }) => record?.outcome === 'void').length,
      failed: expected.filter(({ record }) => record?.outcome === 'failed').length,
      missing: expected.filter(({ record }) => record === undefined).length,
    },
    scores: {
      expected: expectedScores.length,
      scored: expectedScores.filter((s) => s?.outcome === 'scored').length,
      failed: expectedScores.filter((s) => s?.outcome === 'failed').length,
      missing: expectedScores.filter((s) => s === undefined).length,
    },
    spent: {
      generateUsd: answers.reduce((sum, a) => sum + a.spentUsd, 0),
      scoreUsd: scores.reduce((sum, s) => sum + s.spentUsd, 0),
    },
    voids: expected.flatMap(({ record }) =>
      record?.outcome === 'void' ? [{ id: answerId(record), note: record.why }] : [],
    ),
    failures: expected.flatMap(({ record }) =>
      record?.outcome === 'failed'
        ? [{ id: answerId(record), note: `${record.why} (${String(record.tries)} tries)` }]
        : [],
    ),
    scoreFailures: scores.flatMap((s) =>
      s.outcome === 'failed'
        ? [{ id: `${answerId(s)} score ${String(s.score)}`, note: s.why }]
        : [],
    ),
    drafts: answered.flatMap((a) =>
      a.detail.kind === 'swarm' && a.detail.stage !== 'final'
        ? [{ id: answerId(a), note: a.detail.writeUpFailure ?? 'no write-up' }]
        : [],
    ),
    leaking: answered.flatMap((a) =>
      a.detail.kind === 'swarm' && (a.detail.writeUp?.leaks.length ?? 0) > 0
        ? [{ id: answerId(a), sentences: a.detail.writeUp?.leaks ?? [] }]
        : [],
    ),
    truncated: answered.flatMap((a) =>
      a.detail.kind === 'call' && a.detail.truncated ? [answerId(a)] : [],
    ),
    offBudget: answered.flatMap((a) =>
      a.wordBudget === manifest.wordBudget
        ? []
        : [{ id: answerId(a), note: `asked for about ${String(a.wordBudget)} words` }],
    ),
    retried: expected.flatMap(({ record }) =>
      record !== undefined && record.outcome !== 'failed' && record.tries > 1
        ? [{ id: answerId(record), note: `${String(record.tries)} tries` }]
        : [],
    ),
    commits: [...new Set(answers.flatMap((a) => (a.commit === null ? [] : [a.commit])))],
  };
};

// ── Markdown ─────────────────────────────────────────────────────────────────────────────

const usd = (value: number): string => `$${value.toFixed(4)}`;
const num = (value: number | null, digits = 1): string =>
  value === null ? '—' : value.toFixed(digits);
const cell = (text: string): string => text.replace(/\|/g, '\\|').replace(/\n/g, ' ');
const signed = (value: number | null): string =>
  value === null ? '—' : `${value >= 0 ? '+' : ''}${value.toFixed(1)}`;
const table = (head: readonly string[], rows: readonly (readonly string[])[]): string[] => [
  `| ${head.join(' | ')} |`,
  `|${head.map(() => '---').join('|')}|`,
  ...rows.map((row) => `| ${row.join(' | ')} |`),
];
export const renderMeasureReport = (manifest: Manifest, summary: MeasureSummary): string => {
  const lines: string[] = [];
  const scored = summary.scores.scored > 0;
  lines.push(`# Measurement: ${manifest.label}`, '');
  lines.push(
    `- Arms: ${manifest.arms.map((arm) => `\`${armRef(arm)}\``).join(', ')}; ${String(manifest.runs)} runs per problem for a swarm arm, one call for a call arm`,
  );
  for (const [name, what] of Object.entries(manifest.models)) lines.push(`  - ${name}: ${what}`);
  lines.push(
    `- Problems: ${String(manifest.problemIds.length)}; every answer asked for about ${String(manifest.wordBudget)} words with the same sentence; each swarm run capped at ${usd(manifest.runCapUsd)}`,
  );
  lines.push(
    `- Scoring: each answer alone against the rubric, ${String(manifest.scoresPerAnswer)} times, blind to the arm; nothing is judged pairwise`,
  );
  lines.push(
    `- Commit: ${summary.commits.length === 0 ? (manifest.commit ?? 'unknown') : summary.commits.map((c) => `\`${c}\``).join(', ')}${summary.commits.length > 1 ? ' (**the answers were made on more than one commit**)' : ''}`,
  );
  lines.push(
    `- Spent: answers ${usd(summary.spent.generateUsd)}${manifest.caps.generateUsd === null ? '' : ` of a ${usd(manifest.caps.generateUsd)} cap`}; scores ${usd(summary.spent.scoreUsd)}${manifest.caps.scoreUsd === null ? '' : ` of a ${usd(manifest.caps.scoreUsd)} cap`}`,
  );
  if (manifest.fake)
    lines.push('- **Scripted models (`--fake`): nothing here measures anything.**');
  lines.push('');

  // Stage 1.
  lines.push('## Stage 1: the answers', '');
  lines.push(
    `${String(summary.answers.answered)} of ${String(summary.answers.expected)} answers made; ${String(summary.answers.void)} void, ${String(summary.answers.failed)} failed, ${String(summary.answers.missing)} not yet made. Void: no answer, or under half its word budget after its one retry; not scored, and left out of every mean. Failed: nothing came of the attempt for a reason outside the arm; tried again by the next invocation.`,
    '',
  );
  lines.push(
    ...table(
      [
        'Arm',
        'Expected',
        'Answered',
        'Void',
        'Failed',
        'Not yet made',
        'Cost',
        'Words min / median / max',
      ],
      summary.arms.map((a) => [
        `\`${armRef(a.arm)}\``,
        String(a.counts.expected),
        String(a.counts.answered),
        String(a.counts.void),
        String(a.counts.failed),
        String(a.counts.missing),
        usd(a.counts.spentUsd),
        a.counts.words === null
          ? '—'
          : `${String(a.counts.words.min)} / ${num(a.counts.words.median, 0)} / ${String(a.counts.words.max)}`,
      ]),
    ),
    '',
  );
  const swarms = summary.arms.filter((a) => a.swarm !== null);
  if (swarms.length > 0) {
    lines.push(
      ...table(
        [
          'Swarm arm',
          'How the runs ended',
          'Rounds',
          'Final write-ups',
          'Drafts in their place',
          'Write-up asked again: short',
          'for a leak',
          'Still leaking',
          'Mean minutes a run',
        ],
        swarms.map((a) => [
          `\`${armRef(a.arm)}\``,
          Object.entries(a.swarm?.endings ?? {})
            .map(([reason, count]) => `${reason} × ${String(count)}`)
            .join(', ') || '—',
          a.swarm?.rounds == null
            ? '—'
            : `${String(a.swarm.rounds.min)} to ${String(a.swarm.rounds.max)}`,
          String(a.swarm?.final ?? 0),
          String(a.swarm?.drafts ?? 0),
          String(a.swarm?.retriedShort ?? 0),
          String(a.swarm?.retriedLeak ?? 0),
          String(a.swarm?.leaking ?? 0),
          num(a.swarm?.meanMinutes ?? null),
        ]),
      ),
      '',
    );
  }
  const flagged = (title: string, items: readonly Flagged[]): void => {
    if (items.length === 0) return;
    lines.push(`**${title}**`, '');
    for (const item of items) lines.push(`- \`${item.id}\`: ${cell(item.note)}`);
    lines.push('');
  };
  flagged('Void answers', summary.voids);
  flagged('Failed answers', summary.failures);
  flagged('Answers that are a draft because the write-up failed (scored, flagged)', summary.drafts);
  if (summary.leaking.length > 0) {
    lines.push(
      '**Write-ups that still mention the board, the agents or their own confidence after the retry (scored, flagged)**',
      '',
    );
    for (const item of summary.leaking) {
      lines.push(`- \`${item.id}\``);
      for (const sentence of item.sentences) lines.push(`  - "${cell(sentence)}"`);
    }
    lines.push('');
  }
  if (summary.truncated.length > 0) {
    lines.push(
      `**Call answers that used their whole allowance (end probably missing):** ${summary.truncated.map((id) => `\`${id}\``).join(', ')}`,
      '',
    );
  }
  flagged('Answers asked for another length', summary.offBudget);
  flagged('Answers that took more than one invocation', summary.retried);

  // Stage 2.
  lines.push('## Stage 2: the scores', '');
  lines.push(
    `${String(summary.scores.scored)} of ${String(summary.scores.expected)} scores given (${String(manifest.scoresPerAnswer)} for each answered answer); ${String(summary.scores.failed)} failed, ${String(summary.scores.missing)} not yet given.`,
    '',
  );
  flagged('Failed scores', summary.scoreFailures);
  if (!scored) {
    lines.push(
      'No answer has been scored yet: the sections below appear once stage 2 has run.',
      '',
    );
    return lines.join('\n');
  }

  lines.push('## Per arm', '');
  lines.push(
    'Rubric score in percent. An answer’s score is the mean of its scores; an arm’s score on a problem is the mean over its answers; the mean and the spread here are over problems. The development set is the three problems every change of Phase 5 was tried on; the other seven were held out until this measurement.',
    '',
  );
  lines.push(
    ...table(
      [
        'Arm',
        'Mean',
        'SD over problems',
        'Lowest to highest problem',
        'Problems',
        'Development set',
        'Held out',
      ],
      summary.arms.map((a) => [
        `\`${armRef(a.arm)}\``,
        `**${num(a.overProblems.mean)}**`,
        num(a.overProblems.sd),
        a.overProblems.mean === null
          ? '—'
          : `${num(a.overProblems.min)} to ${num(a.overProblems.max)}`,
        String(a.overProblems.n),
        a.development.mean === null
          ? '—'
          : `${num(a.development.mean)} (n ${String(a.development.n)})`,
        a.heldOut.mean === null ? '—' : `${num(a.heldOut.mean)} (n ${String(a.heldOut.n)})`,
      ]),
    ),
    '',
  );

  lines.push('## Answers at 100 %', '');
  lines.push(
    ...table(
      ['Arm', 'Answers with every score at 100 %', 'Single scores at 100 %'],
      summary.arms.map((a) => [
        `\`${armRef(a.arm)}\``,
        `${String(a.ceiling.answersAt100)} of ${String(a.ceiling.answersScored)}`,
        `${String(a.ceiling.scoresAt100)} of ${String(a.ceiling.scores)}`,
      ]),
    ),
    '',
  );

  if (swarms.length > 0) {
    lines.push('## Run to run', '');
    lines.push(
      'How far the same swarm moves between runs on the same problem. Pooled SD: the root of the mean within-problem variance of a run’s score. Range: highest run minus lowest.',
      '',
    );
    lines.push(
      ...table(
        ['Swarm arm', 'Problems with two or more runs', 'Pooled SD', 'Mean range', 'Largest range'],
        swarms.map((a) => [
          `\`${armRef(a.arm)}\``,
          String(a.runToRun?.problems ?? 0),
          num(a.runToRun?.pooledSd ?? null),
          num(a.runToRun?.meanRange ?? null),
          a.runToRun?.largest == null
            ? '—'
            : `${num(a.runToRun.largest.range)} (${a.runToRun.largest.problemId})`,
        ]),
      ),
      '',
    );
    lines.push(
      ...table(
        ['Problem', ...swarms.map((a) => `\`${armRef(a.arm)}\` runs (SD, range)`)],
        manifest.problemIds.map((problemId, index) => [
          problemId,
          ...swarms.map((a) => {
            const c = a.cells[index];
            if (c === undefined || c.answers.length === 0) return '—';
            return `${c.answers.map((answer) => num(answer.mean)).join(' / ')} (${num(c.sd)}, ${num(c.range)})`;
          }),
        ]),
      ),
      '',
    );
  }

  lines.push('## The judge against itself', '');
  lines.push(
    'The same answer scored twice by the same judge with the same prompt: the absolute difference between the two scores, in points.',
    '',
  );
  lines.push(
    ...table(
      ['Arm', 'Answers scored twice', 'Mean difference', 'Largest'],
      [
        ...summary.arms.map((a) => [
          `\`${armRef(a.arm)}\``,
          String(a.judge.answers),
          num(a.judge.meanSpread),
          num(a.judge.largest),
        ]),
        [
          '**All**',
          String(summary.judge.answers),
          num(summary.judge.meanSpread),
          num(summary.judge.largest),
        ],
      ],
    ),
    '',
  );

  lines.push('## Every arm, per problem', '');
  lines.push(
    'A call arm’s cell is its one answer’s score; a swarm arm’s is the mean of its runs, with the lowest and highest run.',
    '',
  );
  lines.push(
    ...table(
      ['Problem', ...summary.arms.map((a) => `\`${armRef(a.arm)}\``)],
      [
        ...manifest.problemIds.map((problemId, index) => [
          `${problemId}${DEVELOPMENT_SET.includes(problemId) ? ' (dev)' : ''}`,
          ...summary.arms.map((a) => {
            const c = a.cells[index];
            if (c?.mean == null) return '—';
            return a.arm.kind === 'call' || c.answers.length < 2
              ? num(c.mean)
              : `${num(c.mean)} (${num(c.min)} to ${num(c.max)})`;
          }),
        ]),
        ['**Mean**', ...summary.arms.map((a) => `**${num(a.overProblems.mean)}**`)],
      ],
    ),
    '',
  );

  for (const comparison of summary.comparisons) {
    const swarm = summary.arms.find((a) => sameArm(a.arm, comparison.swarm));
    const call = summary.arms.find((a) => sameArm(a.arm, comparison.call));
    const runColumns = Array.from({ length: manifest.runs }, (_, i) => i + 1);
    lines.push(`## \`${armRef(comparison.swarm)}\` against \`${armRef(comparison.call)}\``, '');
    lines.push(
      'The swarm beside one call of the model that writes its answer. Δ is the swarm’s mean minus the call’s score.',
      '',
    );
    lines.push(
      ...table(
        [
          'Problem',
          'Call (its scores)',
          ...runColumns.map((run) => `Run ${String(run)}`),
          'Swarm mean',
          'Δ',
          'Runs above the call',
        ],
        comparison.rows.map((row) => [
          `${row.problemId}${DEVELOPMENT_SET.includes(row.problemId) ? ' (dev)' : ''}`,
          row.call === null
            ? '—'
            : `${num(row.call)} (${row.callScores.map((s) => num(s)).join(', ')})`,
          ...runColumns.map((run) => num(row.runs.find((r) => r.run === run)?.score ?? null)),
          num(row.swarm),
          signed(row.delta),
          row.call === null || row.runs.length === 0
            ? '—'
            : `${String(row.runsAbove)} of ${String(row.runs.length)}`,
        ]),
      ),
      '',
    );
    lines.push(
      `Over ${String(comparison.n)} problems: mean Δ **${signed(comparison.meanDelta)}** points (SD ${num(comparison.sdDelta)}, standard error ${num(comparison.seDelta)}); the swarm is ahead on ${String(comparison.ahead)}, behind on ${String(comparison.behind)}, level on ${String(comparison.level)}; ${String(comparison.runsAbove)} of ${String(comparison.runsScored)} single runs scored above the call. For scale: the swarm’s run-to-run pooled SD is ${num(swarm?.runToRun?.pooledSd ?? null)} points, and the judge’s mean difference between its two scores is ${num(swarm?.judge.meanSpread ?? null)} on the swarm’s answers and ${num(call?.judge.meanSpread ?? null)} on the call’s.`,
      '',
    );
  }

  lines.push('## Limits', '');
  lines.push(
    `- A call arm has one answer per problem, so how far a single call moves from one call to the next is not measured here; a swarm arm’s run-to-run spread is.`,
    `- ${String(manifest.problemIds.length)} problems. A difference between two arms smaller than about two standard errors of the mean difference is not established by this measurement.`,
    '- One judge model, scoring alone against a rubric. Its two scores of one answer differ by the figure above; a single answer’s score is no finer than that.',
    '- Scores at 100 % cannot show a better answer: an arm with many answers at the ceiling is under-measured by this rubric.',
    '',
  );
  return lines.join('\n');
};

// ── Spot checks ──────────────────────────────────────────────────────────────────────────

export interface SpotCheck {
  problemId: string;
  why: string;
  markdown: string;
}

/**
 * Three problems in full for a human to read: from the first comparison, where the swarm
 * leads the call by most, where the call leads by most, and where they are closest. Each
 * holds the call's answer and the swarm's median run, with every score they were given and
 * the judge's reasons.
 */
export const spotChecks = (
  manifest: Manifest,
  summary: MeasureSummary,
  problems: readonly Problem[],
  answers: readonly MeasuredAnswer[],
  scores: readonly ScoreRecord[],
): SpotCheck[] => {
  const comparison = summary.comparisons[0];
  if (comparison === undefined) return [];
  const rows = comparison.rows.filter((row) => row.delta !== null);
  if (rows.length === 0) return [];
  const by = (pick: (a: ComparisonRow, b: ComparisonRow) => boolean): ComparisonRow | undefined =>
    rows.reduce<ComparisonRow | undefined>(
      (best, row) => (best === undefined || pick(row, best) ? row : best),
      undefined,
    );
  const picks: { row: ComparisonRow | undefined; why: string }[] = [
    { row: by((a, b) => (a.delta ?? 0) > (b.delta ?? 0)), why: 'the swarm’s widest lead' },
    { row: by((a, b) => (a.delta ?? 0) < (b.delta ?? 0)), why: 'the call’s widest lead' },
    { row: by((a, b) => Math.abs(a.delta ?? 0) < Math.abs(b.delta ?? 0)), why: 'the closest' },
  ];
  const answerOf = new Map(answers.map((a) => [answerId(a), a]));
  const seen = new Set<string>();
  const checks: SpotCheck[] = [];
  for (const { row, why } of picks) {
    if (row === undefined || seen.has(row.problemId)) continue;
    seen.add(row.problemId);
    const problem = problems.find((p) => p.id === row.problemId);
    // The swarm's median run stands for the arm: neither its best nor its worst.
    const ordered = [...row.runs].sort((a, b) => a.score - b.score);
    const medianRun = ordered[Math.floor((ordered.length - 1) / 2)];
    const shown: { title: string; key: AnswerKey }[] = [
      {
        title: `\`${armRef(comparison.call)}\``,
        key: { problemId: row.problemId, arm: comparison.call, run: 1 },
      },
      ...(medianRun === undefined
        ? []
        : [
            {
              title: `\`${armRef(comparison.swarm)}\`, run ${String(medianRun.run)} (its median run)`,
              key: { problemId: row.problemId, arm: comparison.swarm, run: medianRun.run },
            },
          ]),
    ];
    const lines: string[] = [
      `# ${row.problemId}: ${why}`,
      '',
      `\`${armRef(comparison.swarm)}\` ${num(row.swarm)} against \`${armRef(comparison.call)}\` ${num(row.call)} (Δ ${signed(row.delta)}); measurement \`${manifest.label}\`.`,
      '',
      ...(problem === undefined ? [] : ['## Problem', '', problem.statement, '']),
    ];
    for (const { title, key } of shown) {
      const answer = answerOf.get(answerId(key));
      if (answer?.outcome !== 'answered') continue;
      lines.push(`## ${title}`, '', `${String(answer.words)} words.`, '');
      for (const score of scoredOf(scores).filter((s) => answerId(s) === answerId(key))) {
        lines.push(`**Score ${String(score.score)}: ${num(score.percent)} %.** ${score.note}`, '');
        for (const [criterion, given] of Object.entries(score.scores)) {
          lines.push(`- ${criterion}: ${String(given.score)} of 3. ${given.reason}`);
        }
        lines.push('');
      }
      lines.push('### The answer', '', answer.text, '');
    }
    checks.push({ problemId: row.problemId, why, markdown: lines.join('\n') });
  }
  return checks;
};
