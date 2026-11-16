import { z, type ZodType } from 'zod';

import type { BoardView } from '../board/board-view';
import { err, ok, type Result } from '../ports/result';
import {
  CONTRIBUTION_TYPES,
  parseRelation,
  type AnswerRefs,
  type Contribution,
  type ContributionType,
  type ModelContribution,
  type ModelReferenceSchemas,
} from '../schemas/contribution';
import type { Handle } from '../schemas/handle';
import type { AgentContext, AgentOutput, RoleDefinition } from './agent';
import { critiqueStands, rejectedHypothesisIds, standingAnswers } from './eligibility';
import { renderAgentPrompt } from './prompt';

// Models never generate ids. An agent's prompt names entries by handle, its output schema
// admits only the handles that prompt named, and the controller side maps them back to
// UUIDs before anything reaches the commit path. With a provider that decodes against the
// schema, an invalid link cannot be produced; with one that does not, it fails validation
// and takes the repair path like any other schema error.

/** The reference schemas for one call: every named handle, and per type the live ones. */
export const referenceSchemasFor = (
  view: BoardView,
  handles: readonly Handle[],
): ModelReferenceSchemas => {
  const liveOf: Partial<Record<ContributionType, ZodType<string>>> = {};
  for (const type of CONTRIBUTION_TYPES) {
    const live = handles.filter((handle) => {
      const entry = view.byHandle(handle);
      return entry?.type === type && view.isLive(entry.id);
    });
    if (live.length > 0) liveOf[type] = z.enum(live);
  }
  // Critiques that can still be answered: named in the view and still standing.
  const named = new Set<string>(handles);
  const rejected = rejectedHypothesisIds(view);
  const openAgainst = (targetId: string): Handle[] =>
    view.critiquesOf(targetId).flatMap((critique) => {
      const handle = view.handleOf(critique.id);
      return handle !== undefined && named.has(handle) && critiqueStands(view, critique, rejected)
        ? [handle]
        : [];
    });
  const open = handles.filter((handle) => {
    const entry = view.byHandle(handle);
    return entry?.type === 'critique' && critiqueStands(view, entry, rejected);
  });
  // Every live subproblem the view names, with what stands as its answer.
  const answers: AnswerRefs[] = handles.flatMap((handle) => {
    const entry = view.byHandle(handle);
    if (entry?.type !== 'subproblem' || !view.isLive(entry.id)) return [];
    const standing = standingAnswers(view, entry).flatMap((hypothesis) => {
      const h = view.handleOf(hypothesis.id);
      return h === undefined ? [] : [{ hypothesis: h, openCritiques: openAgainst(hypothesis.id) }];
    });
    return [{ subproblem: handle, standing }];
  });
  return {
    any: z.enum([...handles]),
    liveOf,
    ...(open.length === 0 ? {} : { openCritiques: z.enum(open) }),
    ...(answers.length === 0 ? {} : { answers }),
    paragraphs: true,
  };
};

/** How the paragraphs a model returns become the one markdown string the board stores. */
export const PARAGRAPH_SEPARATOR = '\n\n';

export interface AgentRequest {
  system: string;
  prompt: string;
  schema: ZodType<AgentOutput>;
  handles: readonly Handle[];
}

/** A board with nothing to name gives the model nothing it could link to. */
export type AgentRequestError = { kind: 'no_visible_entries' };

/** The prompt and the matching per-call schema: the one place a model request is assembled. */
export const buildAgentRequest = (
  definition: RoleDefinition,
  view: BoardView,
  ctx: AgentContext,
  rolePrompt: string,
): Result<AgentRequest, AgentRequestError> => {
  const rendered = renderAgentPrompt(definition.role, view, ctx, rolePrompt);
  if (rendered.handles.length === 0) return err({ kind: 'no_visible_entries' });
  return ok({
    system: rendered.system,
    prompt: rendered.prompt,
    handles: rendered.handles,
    schema: definition.outputSchema(referenceSchemasFor(view, rendered.handles), ctx.flags),
  });
};

/**
 * Map every handle in a model's contributions back to the entry id it stands for, and join
 * long-form paragraphs into the stored string. Issues are Zod-style `path: message` strings
 * so they can feed the repair prompt directly.
 */
export const resolveHandles = (
  contributions: readonly ModelContribution[],
  view: BoardView,
): Result<Contribution[], string[]> => {
  const issues: string[] = [];
  const resolved = contributions.map((c, index): Contribution => {
    const one = (field: string, handle: string): string => {
      const entry = view.byHandle(handle);
      if (entry !== undefined) return entry.id;
      issues.push(`contributions.${String(index)}.${field}: unknown handle "${handle}"`);
      return handle;
    };
    const many = (field: string, handles: readonly string[]): string[] =>
      handles.map((handle, i) => one(`${field}.${String(i)}`, handle));
    const supersedes = c.supersedes === undefined ? undefined : one('supersedes', c.supersedes);
    const base = {
      content: typeof c.content === 'string' ? c.content : c.content.join(PARAGRAPH_SEPARATOR),
      parents: many('parents', c.parents),
      ...(supersedes === undefined ? {} : { supersedes }),
    };
    switch (c.type) {
      case 'subproblem':
        return { ...base, type: c.type, payload: c.payload };
      case 'hypothesis': {
        if (!('answers' in c)) {
          return {
            ...base,
            type: c.type,
            payload: {
              confidence: c.payload.confidence,
              supportedBy: many('payload.supportedBy', c.payload.supportedBy),
              contradictedBy: many('payload.contradictedBy', c.payload.contradictedBy),
              ...(c.payload.resolves === undefined
                ? {}
                : { resolves: many('payload.resolves', c.payload.resolves) }),
            },
          };
        }
        // An answer to a subproblem (schemas/contribution.ts, `answerSchemas`): what it
        // replaces or rivals is read off `relation` and the subproblem's standing answers.
        const subproblemId = one('answers', c.answers);
        const subproblem = view.byId(subproblemId);
        const standing = subproblem?.type === 'subproblem' ? standingAnswers(view, subproblem) : [];
        const relation = c.relation === undefined ? undefined : parseRelation(c.relation);
        const rival = relation?.rival === true;
        // Stated, or with one standing answer and nothing stated, a new version of it.
        const [only] = standing;
        const replaced =
          relation !== undefined && !relation.rival
            ? one('relation', relation.of)
            : !rival && standing.length === 1
              ? only?.id
              : undefined;
        // A critique is answered by the version that replaces what it attacks: a rival
        // resolves nothing, and a new version only the critiques of the one it replaces.
        const resolves =
          replaced === undefined
            ? []
            : many('payload.resolves', c.payload.resolves ?? []).filter((id) => {
                const critique = view.byId(id);
                return critique?.type === 'critique' && critique.payload.target === replaced;
              });
        return {
          content: base.content,
          // The subproblem it answers comes first, whatever else the model listed.
          parents: [subproblemId, ...base.parents.filter((id) => id !== subproblemId)],
          ...(replaced === undefined ? {} : { supersedes: replaced }),
          type: c.type,
          payload: {
            confidence: c.payload.confidence,
            supportedBy: many('payload.supportedBy', c.payload.supportedBy),
            contradictedBy: many('payload.contradictedBy', c.payload.contradictedBy),
            ...(resolves.length === 0 ? {} : { resolves }),
            ...(rival && standing.length > 0 ? { rivalOf: standing.map((h) => h.id) } : {}),
          },
        };
      }
      case 'evidence':
        return {
          ...base,
          type: c.type,
          payload: {
            source: c.payload.source,
            supports: many('payload.supports', c.payload.supports),
            contradicts: many('payload.contradicts', c.payload.contradicts),
          },
        };
      case 'critique': {
        const resolvedBy =
          c.payload.resolvedBy === undefined
            ? undefined
            : one('payload.resolvedBy', c.payload.resolvedBy);
        return {
          ...base,
          type: c.type,
          payload: {
            target: one('payload.target', c.payload.target),
            severity: c.payload.severity,
            ...(resolvedBy === undefined ? {} : { resolvedBy }),
          },
        };
      }
      case 'question': {
        const answeredBy =
          c.payload.answeredBy === undefined
            ? undefined
            : one('payload.answeredBy', c.payload.answeredBy);
        return { ...base, type: c.type, payload: answeredBy === undefined ? {} : { answeredBy } };
      }
      case 'decision':
        return {
          ...base,
          type: c.type,
          payload: {
            chosen: one('payload.chosen', c.payload.chosen),
            rejected: many('payload.rejected', c.payload.rejected),
            rationale: c.payload.rationale,
          },
        };
      case 'synthesis':
        return {
          ...base,
          type: c.type,
          payload: {
            version: c.payload.version,
            confidence: c.payload.confidence,
            cites: many('payload.cites', c.payload.cites),
          },
        };
    }
  });
  return issues.length > 0 ? err(issues) : ok(resolved);
};
