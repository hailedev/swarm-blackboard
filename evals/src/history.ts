import { err, ok, type Result } from '@team/core';
import { z } from 'zod';

// What earlier passes say about an answer: every pairwise score a given text has received,
// and the answer it was judged beside. Read from the passes' committed `report.json`
// (report.ts writes it), by the text of the answer: a cached baseline is the same answer
// in every pass that reused it, and so has one score per pass.

/** The part of a pass's `report.json` this needs; everything else is ignored. */
export const PriorReportSchema = z.object({
  pass: z.object({
    results: z.array(
      z.object({
        problem: z.object({ id: z.string().min(1) }),
        swarm: z
          .object({
            runId: z.string().min(1),
            answer: z.string().nullable(),
            writeUp: z.object({ wordBudget: z.number() }).nullable().optional(),
          })
          .nullable(),
        baseline: z
          .object({
            answer: z.string(),
            modelId: z.string().min(1),
            wordBudget: z.number(),
          })
          .nullable(),
        judgements: z.array(z.unknown()),
        scores: z.object({ swarm: z.number().nullable(), baseline: z.number().nullable() }),
      }),
    ),
  }),
});
export type PriorReport = z.infer<typeof PriorReportSchema>;

export interface PriorPass {
  /** The pass's label: its results folder without the date. */
  label: string;
  report: PriorReport;
}

/** `2026-11-17-step2b` → `step2b`; a name with no date in front is its own label. */
export const passLabelOf = (folder: string): string => folder.replace(/^\d{4}-\d{2}-\d{2}-/, '');

export interface SwarmAnswerOfPass {
  answer: string;
  runId: string;
  wordBudget: number | null;
}

/** The swarm's answer on a problem in a pass, or why there is none. */
export const swarmAnswerOf = (
  passes: readonly PriorPass[],
  label: string,
  problemId: string,
): Result<SwarmAnswerOfPass, string> => {
  const pass = passes.find((p) => p.label === label);
  if (pass === undefined) {
    return err(`no pass labelled "${label}"; passes are ${passes.map((p) => p.label).join(', ')}`);
  }
  const result = pass.report.pass.results.find((r) => r.problem.id === problemId);
  if (result === undefined) return err(`pass "${label}" did not run ${problemId}`);
  if (result.swarm?.answer == null) {
    return err(`pass "${label}" has no swarm answer for ${problemId}`);
  }
  return ok({
    answer: result.swarm.answer,
    runId: result.swarm.runId,
    wordBudget: result.swarm.writeUp?.wordBudget ?? null,
  });
};

export interface PairwiseScore {
  /** The pass, or session, in which the score was given. */
  pass: string;
  /** The answer's rubric score there, a percentage. */
  score: number;
  /** The answer it was judged beside. */
  opponent: string;
}

/** Every pairwise score the answer with this text has received on this problem, oldest pass first. */
export const pairwiseHistory = (
  passes: readonly PriorPass[],
  problemId: string,
  text: string,
): PairwiseScore[] =>
  passes.flatMap((pass): PairwiseScore[] => {
    const result = pass.report.pass.results.find((r) => r.problem.id === problemId);
    // A pair that was not judged gave nobody a score, whatever the table says.
    if (result === undefined || result.judgements.length === 0) return [];
    const scores: PairwiseScore[] = [];
    if (result.swarm?.answer === text && result.scores.swarm !== null && result.baseline !== null) {
      scores.push({
        pass: pass.label,
        score: result.scores.swarm,
        opponent: `the ${result.baseline.modelId} baseline`,
      });
    }
    if (result.baseline?.answer === text && result.scores.baseline !== null) {
      scores.push({
        pass: pass.label,
        score: result.scores.baseline,
        opponent: `the swarm answer of ${pass.label}`,
      });
    }
    return scores;
  });
