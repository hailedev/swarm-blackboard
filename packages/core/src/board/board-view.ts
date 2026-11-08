import type { Entry, EntryOf } from '../schemas/entry';
import type { BoardEvent } from '../schemas/event';
import type { EntryType } from '../schemas/payloads';

// The materialised "current view" of a run: a pure fold over its event log.
//
// Liveness rules (ADR-0004):
// - an entry is *superseded* when any later entry names it in `supersedes`,
//   whatever that later entry's status is;
// - an entry is *live* when it is not superseded and its status is not `dismissed`.
// Dismissing or pinning therefore means committing a copy that supersedes the
// original with the new status; un-dismissing supersedes that copy again.
export interface BoardView {
  readonly runId: string;
  /** Every committed entry, in commit order. */
  readonly entries: readonly Entry[];
  /** Live entries, in commit order. */
  readonly live: readonly Entry[];
  /** Highest round that has started (0 before the first round). */
  readonly round: number;
  /** Round of the most recently committed entry, or null when the board is empty. */
  readonly lastEntryRound: number | null;

  byId(id: string): Entry | undefined;
  isLive(id: string): boolean;
  problem(): EntryOf<'problem'> | undefined;
  liveOfType<T extends EntryType>(type: T): readonly EntryOf<T>[];
  /** The entry that supersedes `id`, if any (the most recent one wins). */
  supersededBy(id: string): Entry | undefined;
  /** Supersede history from the root of the chain to its latest entry. */
  chain(id: string): readonly Entry[];
  /** Entries listing `id` among their parents. */
  childrenOf(id: string): readonly Entry[];
  /** Live critiques whose target is `id`. */
  critiquesOf(id: string): readonly EntryOf<'critique'>[];
  /** Live evidence supporting a hypothesis, linked from either side. */
  evidenceSupporting(hypothesisId: string): readonly EntryOf<'evidence'>[];
  /** Live evidence contradicting a hypothesis, linked from either side. */
  evidenceContradicting(hypothesisId: string): readonly EntryOf<'evidence'>[];
  /** Live blocking critiques that are unresolved and whose target is still live. */
  openBlockingCritiques(): readonly EntryOf<'critique'>[];
}

const isType =
  <T extends EntryType>(type: T) =>
  (entry: Entry): entry is EntryOf<T> =>
    entry.type === type;

class MaterialisedBoardView implements BoardView {
  readonly runId: string;
  readonly entries: readonly Entry[];
  readonly live: readonly Entry[];
  readonly round: number;
  readonly lastEntryRound: number | null;

  readonly #byId = new Map<string, Entry>();
  readonly #supersededBy = new Map<string, Entry>();
  readonly #children = new Map<string, Entry[]>();

  constructor(runId: string, events: readonly BoardEvent[]) {
    this.runId = runId;
    const entries: Entry[] = [];
    let round = 0;
    for (const event of events) {
      if (event.type === 'round_started') round = Math.max(round, event.round);
      if (event.type !== 'entry_committed') continue;
      const entry = event.entry;
      entries.push(entry);
      this.#byId.set(entry.id, entry);
      if (entry.supersedes !== undefined) this.#supersededBy.set(entry.supersedes, entry);
      for (const parent of entry.parents) {
        const siblings = this.#children.get(parent) ?? [];
        siblings.push(entry);
        this.#children.set(parent, siblings);
      }
    }
    this.entries = entries;
    this.live = entries.filter((entry) => this.isLive(entry.id));
    this.round = round;
    const last = entries.at(-1);
    this.lastEntryRound = last === undefined ? null : last.round;
  }

  byId(id: string): Entry | undefined {
    return this.#byId.get(id);
  }

  isLive(id: string): boolean {
    const entry = this.#byId.get(id);
    return entry !== undefined && entry.status !== 'dismissed' && !this.#supersededBy.has(id);
  }

  problem(): EntryOf<'problem'> | undefined {
    return this.liveOfType('problem')[0];
  }

  liveOfType<T extends EntryType>(type: T): readonly EntryOf<T>[] {
    return this.live.filter(isType(type));
  }

  supersededBy(id: string): Entry | undefined {
    return this.#supersededBy.get(id);
  }

  chain(id: string): readonly Entry[] {
    let root = this.#byId.get(id);
    if (root === undefined) return [];
    while (root.supersedes !== undefined) {
      const previous = this.#byId.get(root.supersedes);
      if (previous === undefined) break;
      root = previous;
    }
    const chain: Entry[] = [root];
    let next = this.#supersededBy.get(root.id);
    while (next !== undefined) {
      chain.push(next);
      next = this.#supersededBy.get(next.id);
    }
    return chain;
  }

  childrenOf(id: string): readonly Entry[] {
    return this.#children.get(id) ?? [];
  }

  critiquesOf(id: string): readonly EntryOf<'critique'>[] {
    return this.liveOfType('critique').filter((critique) => critique.payload.target === id);
  }

  evidenceSupporting(hypothesisId: string): readonly EntryOf<'evidence'>[] {
    return this.#linkedEvidence(hypothesisId, 'supports', 'supportedBy');
  }

  evidenceContradicting(hypothesisId: string): readonly EntryOf<'evidence'>[] {
    return this.#linkedEvidence(hypothesisId, 'contradicts', 'contradictedBy');
  }

  openBlockingCritiques(): readonly EntryOf<'critique'>[] {
    return this.liveOfType('critique').filter(
      (critique) =>
        critique.payload.severity === 'blocking' &&
        critique.payload.resolvedBy === undefined &&
        this.isLive(critique.payload.target),
    );
  }

  #linkedEvidence(
    hypothesisId: string,
    fromEvidence: 'supports' | 'contradicts',
    fromHypothesis: 'supportedBy' | 'contradictedBy',
  ): readonly EntryOf<'evidence'>[] {
    const hypothesis = this.#byId.get(hypothesisId);
    const referenced = new Set(
      hypothesis?.type === 'hypothesis' ? hypothesis.payload[fromHypothesis] : [],
    );
    return this.liveOfType('evidence').filter(
      (evidence) =>
        evidence.payload[fromEvidence].includes(hypothesisId) || referenced.has(evidence.id),
    );
  }
}

export const buildBoardView = (runId: string, events: readonly BoardEvent[]): BoardView =>
  new MaterialisedBoardView(runId, events);
