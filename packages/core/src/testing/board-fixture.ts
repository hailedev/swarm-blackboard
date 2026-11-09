import { isoFromMs } from '../ports/clock';
import type { IdGenerator } from '../ports/ids';
import { buildBoardView, type BoardView } from '../board/board-view';
import { zeroUsage, type EntryStatus, type Usage } from '../schemas/common';
import { EntrySchema, type EntryOf } from '../schemas/entry';
import type { BoardEvent } from '../schemas/event';
import type { EntryType } from '../schemas/payloads';
import { TEST_EPOCH_MS } from './manual-clock';
import { SequentialIdGenerator } from './sequential-id-generator';

export interface EntryOverrides {
  author?: string;
  parents?: string[];
  supersedes?: string;
  status?: EntryStatus;
  content?: string;
  usage?: Usage;
}

// Builds a valid event log by hand for tests: entries are validated against
// EntrySchema, ids are sequential unless a generator is supplied (the local-model trial
// passes real UUID v7s), and the view can be materialised at any point.
export class BoardFixture {
  readonly ids: IdGenerator;
  readonly runId: string;
  readonly events: BoardEvent[] = [];
  round = 0;

  constructor(ids: IdGenerator = new SequentialIdGenerator()) {
    this.ids = ids;
    this.runId = this.ids.next();
  }

  startRound(round: number): void {
    this.round = round;
    this.events.push({
      id: this.ids.next(),
      runId: this.runId,
      seq: this.events.length,
      at: isoFromMs(TEST_EPOCH_MS + this.events.length),
      type: 'round_started',
      round,
    });
  }

  entry<T extends EntryType>(
    type: T,
    payload: EntryOf<T>['payload'],
    overrides: EntryOverrides = {},
  ): EntryOf<T> {
    const id = this.ids.next();
    const parsed = EntrySchema.parse({
      id,
      runId: this.runId,
      type,
      round: this.round,
      author: overrides.author ?? `${type}-author`,
      createdAt: isoFromMs(TEST_EPOCH_MS + this.events.length),
      parents: overrides.parents ?? [],
      supersedes: overrides.supersedes,
      status: overrides.status ?? 'active',
      content: overrides.content ?? `${type} ${id.slice(-4)}`,
      usage: overrides.usage ?? zeroUsage(),
      payload,
    });
    this.events.push({
      id: this.ids.next(),
      runId: this.runId,
      seq: this.events.length,
      at: parsed.createdAt,
      type: 'entry_committed',
      round: this.round,
      entry: parsed,
    });
    return parsed as EntryOf<T>;
  }

  problem(content = 'Should we adopt a monorepo?'): EntryOf<'problem'> {
    return this.entry(
      'problem',
      { constraints: [], successCriteria: [] },
      { author: 'human', content },
    );
  }

  view(): BoardView {
    return buildBoardView(this.runId, this.events);
  }
}
