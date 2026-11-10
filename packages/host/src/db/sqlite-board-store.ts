import {
  BoardEventSchema,
  err,
  handleFor,
  ok,
  type BoardEvent,
  type BoardStore,
  type Entry,
  type Result,
  type RunProfile,
  type RunTotals,
  type StoreError,
} from '@team/core';
import { and, asc, count, eq, max, sql } from 'drizzle-orm';

import type { Db } from './open';
import { agentConfigs, entries, events, runs } from './schema';

// Core's BoardStore over SQLite (ADR-0004, ADR-0007). Every event is appended as a row
// in one transaction with whatever it materialises: a run row on run_started, an entry
// row on entry_committed, totals on round_completed, status on pause/resume/end. The
// event log stays the source of truth; `eventsFor` reads it back for replay.

const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : 'database unavailable';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

const totalsUpdate = (totals: RunTotals) => ({
  rounds: totals.rounds,
  entries: totals.entries,
  elapsedMs: totals.elapsedMs,
  inputTokens: totals.usage.inputTokens,
  outputTokens: totals.usage.outputTokens,
  cacheReadTokens: totals.usage.cacheReadTokens,
  cacheWriteTokens: totals.usage.cacheWriteTokens,
  reasoningTokens: totals.usage.reasoningTokens,
  costUsd: totals.usage.costUsd,
});

const configRows = (runId: string, profile: RunProfile) => {
  const row = (
    kind: 'role' | 'bidder' | 'fallback',
    role: string | null,
    model: RunProfile['fallback'],
  ) =>
    model === null
      ? []
      : [
          {
            id: role === null ? `${runId}:${kind}` : `${runId}:${kind}:${role}`,
            runId,
            kind,
            role,
            alias: model.alias,
            provider: model.provider,
            model: model.model,
            think: model.think ?? null,
            numCtx: model.numCtx ?? null,
            charsPerToken: model.charsPerToken ?? null,
          },
        ];
  return [
    ...Object.entries(profile.roles).flatMap(([role, model]) => row('role', role, model)),
    ...row('bidder', null, profile.bidder),
    ...row('fallback', null, profile.fallback),
  ];
};

const entryRow = (runId: string, seq: number, handle: string, entry: Entry) => ({
  id: entry.id,
  runId,
  seq,
  handle,
  type: entry.type,
  round: entry.round,
  author: entry.author,
  createdAt: entry.createdAt,
  supersedes: entry.supersedes ?? null,
  status: entry.status,
  content: entry.content,
  parentsJson: JSON.stringify(entry.parents),
  payloadJson: JSON.stringify(entry.payload),
  inputTokens: entry.usage.inputTokens,
  outputTokens: entry.usage.outputTokens,
  cacheReadTokens: entry.usage.cacheReadTokens,
  cacheWriteTokens: entry.usage.cacheWriteTokens,
  reasoningTokens: entry.usage.reasoningTokens,
  costUsd: entry.usage.costUsd,
});

export class SqliteBoardStore implements BoardStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  append(event: BoardEvent): Promise<Result<void, StoreError>> {
    try {
      return Promise.resolve(this.#db.transaction((tx) => this.#appendIn(tx, event)));
    } catch (cause) {
      return Promise.resolve(err({ kind: 'unavailable', message: messageOf(cause) }));
    }
  }

  eventsFor(runId: string): Promise<readonly BoardEvent[]> {
    const rows = this.#db
      .select({ payloadJson: events.payloadJson })
      .from(events)
      .where(eq(events.runId, runId))
      .orderBy(asc(events.seq))
      .all();
    return Promise.resolve(rows.map((row) => BoardEventSchema.parse(JSON.parse(row.payloadJson))));
  }

  #appendIn(tx: Tx, event: BoardEvent): Result<void, StoreError> {
    const last = tx
      .select({ seq: max(events.seq) })
      .from(events)
      .where(eq(events.runId, event.runId))
      .get();
    const expected = (last?.seq ?? -1) + 1;
    if (event.seq !== expected) {
      return err({ kind: 'out_of_order', runId: event.runId, expected, actual: event.seq });
    }
    // The run row must exist before the first event's foreign key is checked.
    if (event.type === 'run_started') {
      tx.insert(runs)
        .values({
          id: event.runId,
          problemContent: event.problemEntry.content,
          status: 'running',
          profileName: event.profile?.name ?? null,
          configJson: JSON.stringify(event.config),
          startedAt: event.at,
        })
        .run();
      const configs = event.profile === null ? [] : configRows(event.runId, event.profile);
      if (configs.length > 0) tx.insert(agentConfigs).values(configs).run();
    }
    tx.insert(events)
      .values({
        id: event.id,
        runId: event.runId,
        seq: event.seq,
        type: event.type,
        at: event.at,
        round: 'round' in event ? event.round : null,
        payloadJson: JSON.stringify(event),
      })
      .run();
    switch (event.type) {
      case 'entry_committed': {
        const prior = tx
          .select({ n: count() })
          .from(entries)
          .where(and(eq(entries.runId, event.runId), eq(entries.type, event.entry.type)))
          .get();
        const handle = handleFor(event.entry.type, (prior?.n ?? 0) + 1);
        tx.insert(entries)
          .values(entryRow(event.runId, event.seq, handle, event.entry))
          .run();
        tx.update(runs)
          .set({ entries: sql`${runs.entries} + 1` })
          .where(eq(runs.id, event.runId))
          .run();
        break;
      }
      case 'round_completed':
      case 'round_abandoned':
        tx.update(runs)
          .set({
            rounds: event.round,
            inputTokens: sql`${runs.inputTokens} + ${event.usage.inputTokens}`,
            outputTokens: sql`${runs.outputTokens} + ${event.usage.outputTokens}`,
            cacheReadTokens: sql`${runs.cacheReadTokens} + ${event.usage.cacheReadTokens}`,
            cacheWriteTokens: sql`${runs.cacheWriteTokens} + ${event.usage.cacheWriteTokens}`,
            reasoningTokens: sql`${runs.reasoningTokens} + ${event.usage.reasoningTokens}`,
            costUsd: sql`${runs.costUsd} + ${event.usage.costUsd}`,
          })
          .where(eq(runs.id, event.runId))
          .run();
        break;
      case 'run_resumed':
        tx.update(runs)
          .set({ status: 'running', reason: null })
          .where(eq(runs.id, event.runId))
          .run();
        break;
      case 'run_paused':
        tx.update(runs)
          .set({ status: 'paused', reason: event.reason, ...totalsUpdate(event.totals) })
          .where(eq(runs.id, event.runId))
          .run();
        break;
      case 'run_terminated':
        tx.update(runs)
          .set({
            status: event.status,
            reason: event.reason,
            endedAt: event.at,
            ...totalsUpdate(event.totals),
          })
          .where(eq(runs.id, event.runId))
          .run();
        break;
      case 'run_started':
      case 'round_started':
      case 'agents_selected':
      case 'agent_failed':
      case 'synthesis_requested':
      case 'budget_warning':
        break;
    }
    return ok(undefined);
  }
}
