import type { Arm, CriterionScore, UnblindedJudgement } from './judge';
import { MAX_SCORE, rubricMaximum, type RubricCriterion } from './problems';

// Rubric arithmetic and the pass-level numbers (ADR-0012). A problem's arm score is the
// weighted percentage of the rubric maximum, averaged over the judging orders; the pass
// reports means, wins, position bias and the judge's own consistency, so a difference
// between arms can be read against the noise of the judge that produced it.

export const weightedPercent = (
  rubric: readonly RubricCriterion[],
  scores: Record<string, CriterionScore>,
): number => {
  const maximum = rubricMaximum(rubric);
  if (maximum === 0) return 0;
  const total = rubric.reduce(
    (sum, c) => sum + c.weight * Math.min(MAX_SCORE, Math.max(0, scores[c.id]?.score ?? 0)),
    0,
  );
  return (total / maximum) * 100;
};

export interface ProblemScores {
  /** Mean weighted percentage over the judging orders; null when the arm was not judged. */
  swarm: number | null;
  baseline: number | null;
  /** swarm − baseline, when both were judged. */
  delta: number | null;
  /** Who the judge preferred, by majority over the orders; null when not judged. */
  winner: Arm | 'tie' | null;
  /** How far the two orders' percentages differed, averaged over the arms; null with one order. */
  consistency: number | null;
}

const mean = (values: readonly number[]): number | null =>
  values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length;

const majority = (preferences: readonly (Arm | 'tie')[]): Arm | 'tie' | null => {
  if (preferences.length === 0) return null;
  const count = (p: Arm | 'tie'): number => preferences.filter((x) => x === p).length;
  const swarm = count('swarm');
  const baseline = count('baseline');
  if (swarm > baseline) return 'swarm';
  if (baseline > swarm) return 'baseline';
  return 'tie';
};

export const scoreProblem = (
  rubric: readonly RubricCriterion[],
  judgements: readonly UnblindedJudgement[],
): ProblemScores => {
  const swarmPercents = judgements.map((j) => weightedPercent(rubric, j.swarm));
  const baselinePercents = judgements.map((j) => weightedPercent(rubric, j.baseline));
  const swarm = mean(swarmPercents);
  const baseline = mean(baselinePercents);
  const spread = (values: readonly number[]): number | null =>
    values.length < 2 ? null : Math.max(...values) - Math.min(...values);
  const spreads = [spread(swarmPercents), spread(baselinePercents)].filter(
    (s): s is number => s !== null,
  );
  return {
    swarm,
    baseline,
    delta: swarm === null || baseline === null ? null : swarm - baseline,
    winner: majority(judgements.map((j) => j.preferred)),
    consistency: mean(spreads),
  };
};

export interface Aggregate {
  problems: number;
  /** Problems where both arms were judged at least once. */
  judged: number;
  swarmMean: number | null;
  baselineMean: number | null;
  meanDelta: number | null;
  wins: number;
  losses: number;
  ties: number;
  /** How often the judge preferred whichever answer it was shown first, over all judgements. */
  firstShownPreferred: { count: number; of: number };
  /** Mean of the per-problem consistency figures; the judge's own noise band. */
  consistency: number | null;
}

export const aggregate = (
  results: readonly { scores: ProblemScores; judgements: readonly UnblindedJudgement[] }[],
): Aggregate => {
  const judged = results.filter((r) => r.scores.swarm !== null && r.scores.baseline !== null);
  const all = results.flatMap((r) => r.judgements);
  const decided = all.filter((j) => j.preferred !== 'tie');
  return {
    problems: results.length,
    judged: judged.length,
    swarmMean: mean(judged.map((r) => r.scores.swarm ?? 0)),
    baselineMean: mean(judged.map((r) => r.scores.baseline ?? 0)),
    meanDelta: mean(judged.map((r) => r.scores.delta ?? 0)),
    wins: judged.filter((r) => r.scores.winner === 'swarm').length,
    losses: judged.filter((r) => r.scores.winner === 'baseline').length,
    ties: judged.filter((r) => r.scores.winner === 'tie').length,
    firstShownPreferred: {
      count: decided.filter((j) => j.preferred === j.order.A).length,
      of: decided.length,
    },
    consistency: mean(
      results.map((r) => r.scores.consistency).filter((c): c is number => c !== null),
    ),
  };
};
