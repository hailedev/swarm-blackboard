import type { BoardView } from '../board/board-view';
import type { IdGenerator } from '../ports/ids';
import { zeroUsage, type Usage } from '../schemas/common';
import type { Contribution } from '../schemas/contribution';
import { EntrySchema, type Entry } from '../schemas/entry';

interface Reference {
  field: string;
  ids: readonly string[];
}

const references = (c: Contribution): Reference[] => {
  const refs: Reference[] = [{ field: 'parents', ids: c.parents }];
  switch (c.type) {
    case 'hypothesis':
      refs.push(
        { field: 'supportedBy', ids: c.payload.supportedBy },
        { field: 'contradictedBy', ids: c.payload.contradictedBy },
      );
      break;
    case 'evidence':
      refs.push(
        { field: 'supports', ids: c.payload.supports },
        { field: 'contradicts', ids: c.payload.contradicts },
      );
      break;
    case 'critique':
      refs.push({ field: 'target', ids: [c.payload.target] });
      if (c.payload.resolvedBy !== undefined) {
        refs.push({ field: 'resolvedBy', ids: [c.payload.resolvedBy] });
      }
      break;
    case 'question':
      if (c.payload.answeredBy !== undefined) {
        refs.push({ field: 'answeredBy', ids: [c.payload.answeredBy] });
      }
      break;
    case 'decision':
      refs.push(
        { field: 'chosen', ids: [c.payload.chosen] },
        { field: 'rejected', ids: c.payload.rejected },
      );
      break;
    case 'synthesis':
      refs.push({ field: 'cites', ids: c.payload.cites });
      break;
    case 'subproblem':
      break;
  }
  return refs;
};

/** Every id a contribution points at must exist; `supersedes` must be live and of the same type. */
export const linkProblems = (contribution: Contribution, view: BoardView): string[] => {
  const problems = references(contribution).flatMap(({ field, ids }) =>
    ids
      .filter((id) => view.byId(id) === undefined)
      .map((id) => `${field} references unknown entry ${id}`),
  );
  if (contribution.supersedes !== undefined) {
    const target = view.byId(contribution.supersedes);
    if (target === undefined) {
      problems.push(`supersedes unknown entry ${contribution.supersedes}`);
    } else if (!view.isLive(target.id)) {
      problems.push(`supersedes entry ${target.id}, which is not live`);
    } else if (target.type !== contribution.type) {
      problems.push(`supersedes a ${target.type} entry with a ${contribution.type}`);
    }
  }
  return problems;
};

export interface PrepareInput {
  contributions: readonly Contribution[];
  view: BoardView;
  ids: IdGenerator;
  runId: string;
  round: number;
  author: string;
  createdAt: string;
  /** Usage of the model call that produced the batch; attributed to its first accepted entry. */
  usage: Usage;
}

export interface PreparedBatch {
  entries: Entry[];
  problems: string[];
}

// Validates links and stamps controller-owned fields. Bad contributions are
// dropped with a reason; good ones in the same batch are kept.
export const prepareEntries = (input: PrepareInput): PreparedBatch => {
  const entries: Entry[] = [];
  const problems: string[] = [];
  input.contributions.forEach((contribution, index) => {
    const links = linkProblems(contribution, input.view);
    if (links.length > 0) {
      problems.push(`contribution ${String(index)} (${contribution.type}): ${links.join('; ')}`);
      return;
    }
    const parsed = EntrySchema.safeParse({
      ...contribution,
      id: input.ids.next(),
      runId: input.runId,
      round: input.round,
      author: input.author,
      createdAt: input.createdAt,
      status: 'active',
      usage: entries.length === 0 ? input.usage : zeroUsage(),
    });
    if (!parsed.success) {
      problems.push(
        `contribution ${String(index)} (${contribution.type}): ${parsed.error.issues
          .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
          .join('; ')}`,
      );
      return;
    }
    entries.push(parsed.data);
  });
  return { entries, problems };
};
