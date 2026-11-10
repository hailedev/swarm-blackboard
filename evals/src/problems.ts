import { err, ok, type Result } from '@team/core';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

// A benchmark problem: markdown with a YAML front matter (docs/PLAN.md §5, ADR-0012). The
// body is the statement both arms receive verbatim; the front matter carries what the
// swarm's `problem` entry needs (constraints, success criteria) and the rubric the judge
// scores against. Every criterion is scored 0–3 against its own anchors.

export const MAX_SCORE = 3;

const Slug = z.string().regex(/^[a-z][a-z0-9-]*$/, 'lower-case letters, digits and hyphens');

export const RubricCriterionSchema = z.object({
  id: Slug,
  /** 1–3: how much the criterion counts in the weighted total. */
  weight: z.int().min(1).max(3),
  criterion: z.string().min(1),
  /** Anchors for 0, 1, 2 and 3, in one string the judge reads. */
  scale: z.string().min(1),
});
export type RubricCriterion = z.infer<typeof RubricCriterionSchema>;

export const ProblemSchema = z.object({
  id: Slug,
  title: z.string().min(1),
  domain: z.string().min(1),
  constraints: z.array(z.string().min(1)),
  successCriteria: z.array(z.string().min(1)),
  rubric: z
    .array(RubricCriterionSchema)
    .min(3)
    .max(6)
    .refine((rubric) => new Set(rubric.map((c) => c.id)).size === rubric.length, {
      message: 'rubric criterion ids must be unique',
    }),
  statement: z.string().min(1),
});
export type Problem = z.infer<typeof ProblemSchema>;

const FRONT_MATTER_OPEN = '---\n';
const FRONT_MATTER_CLOSE = '\n---\n';

/** Parses one problem file. `name` only labels the error. */
export const parseProblemFile = (text: string, name = 'problem'): Result<Problem, string> => {
  const normalised = text.replace(/\r\n/g, '\n');
  if (!normalised.startsWith(FRONT_MATTER_OPEN)) {
    return err(`${name}: must start with a "---" front matter line`);
  }
  const close = normalised.indexOf(FRONT_MATTER_CLOSE, FRONT_MATTER_OPEN.length);
  if (close === -1) return err(`${name}: the front matter is never closed with "---"`);
  const frontMatter = normalised.slice(FRONT_MATTER_OPEN.length, close);
  const statement = normalised.slice(close + FRONT_MATTER_CLOSE.length).trim();
  let raw: unknown;
  try {
    raw = parseYaml(frontMatter);
  } catch (cause) {
    return err(
      `${name}: front matter is not YAML (${cause instanceof Error ? cause.message : 'unknown error'})`,
    );
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return err(`${name}: front matter must be a mapping`);
  }
  const parsed = ProblemSchema.safeParse({ ...raw, statement });
  if (!parsed.success) {
    return err(
      `${name}: ${parsed.error.issues.map((i) => `${i.path.map(String).join('.') || 'problem'}: ${i.message}`).join('; ')}`,
    );
  }
  return ok(parsed.data);
};

const bullets = (items: readonly string[]): string => items.map((item) => `- ${item}`).join('\n');

/** The problem as both arms see it: statement, then constraints and success criteria. */
export const problemText = (problem: Problem): string =>
  [
    problem.statement,
    problem.constraints.length > 0 ? `## Constraints\n${bullets(problem.constraints)}` : null,
    problem.successCriteria.length > 0
      ? `## Success criteria\n${bullets(problem.successCriteria)}`
      : null,
  ]
    .filter((part): part is string => part !== null)
    .join('\n\n');

/** The most a rubric can score: Σ weight × MAX_SCORE. */
export const rubricMaximum = (rubric: readonly RubricCriterion[]): number =>
  rubric.reduce((total, c) => total + c.weight * MAX_SCORE, 0);
