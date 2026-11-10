import { index, integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

// The Phase 3 tables (docs/PLAN.md §6). Postgres-portable per ADR-0007: UUID v7 ids as
// text, ISO-8601 timestamps as text, JSON payloads as text, integers and reals only.
// The event log is the source of truth (ADR-0004); `runs` and `entries` are materialised
// from it on write so the API can list and query without folding every log.

const usageColumns = {
  inputTokens: integer('input_tokens').notNull().default(0),
  outputTokens: integer('output_tokens').notNull().default(0),
  cacheReadTokens: integer('cache_read_tokens').notNull().default(0),
  cacheWriteTokens: integer('cache_write_tokens').notNull().default(0),
  /** The part of output_tokens spent thinking (ADR-0013). */
  reasoningTokens: integer('reasoning_tokens').notNull().default(0),
  costUsd: real('cost_usd').notNull().default(0),
};

/** One run: the problem, where it stands, and its totals so far. */
export const runs = sqliteTable('runs', {
  id: text('id').primaryKey(),
  problemContent: text('problem_content').notNull(),
  /** `running`, or a core RunStatus once the run paused or ended. */
  status: text('status').notNull(),
  /** A core RunEndReason once the run paused or ended. */
  reason: text('reason'),
  profileName: text('profile_name'),
  configJson: text('config_json').notNull(),
  startedAt: text('started_at').notNull(),
  endedAt: text('ended_at'),
  rounds: integer('rounds').notNull().default(0),
  entries: integer('entries').notNull().default(0),
  elapsedMs: integer('elapsed_ms').notNull().default(0),
  ...usageColumns,
});

/** The append-only event log, one row per BoardEvent, the whole event as JSON. */
export const events = sqliteTable(
  'events',
  {
    id: text('id').primaryKey(),
    runId: text('run_id')
      .notNull()
      .references(() => runs.id),
    seq: integer('seq').notNull(),
    type: text('type').notNull(),
    at: text('at').notNull(),
    round: integer('round'),
    payloadJson: text('payload_json').notNull(),
  },
  (t) => [uniqueIndex('events_run_seq').on(t.runId, t.seq)],
);

/** Every committed entry, materialised from `entry_committed` events, with its handle. */
export const entries = sqliteTable(
  'entries',
  {
    id: text('id').primaryKey(),
    runId: text('run_id')
      .notNull()
      .references(() => runs.id),
    /** Sequence number of the event that committed it. */
    seq: integer('seq').notNull(),
    /** The handle agents know it by (H3, E7, …), as the board view assigns it. */
    handle: text('handle').notNull(),
    type: text('type').notNull(),
    round: integer('round').notNull(),
    author: text('author').notNull(),
    createdAt: text('created_at').notNull(),
    supersedes: text('supersedes'),
    status: text('status').notNull(),
    content: text('content').notNull(),
    parentsJson: text('parents_json').notNull(),
    payloadJson: text('payload_json').notNull(),
    ...usageColumns,
  },
  (t) => [
    index('entries_run_seq').on(t.runId, t.seq),
    uniqueIndex('entries_run_handle').on(t.runId, t.handle),
  ],
);

/**
 * Every traced model call (core's ModelCallTraceSchema) plus imported ledger rows. The
 * spend ledger is a SUM over `billing = 'api'`; calibration reads `estimate_chars` and
 * `actual_input_tokens`. `run_id` has no foreign key: contract tests trace calls that
 * belong to no run.
 */
export const modelCalls = sqliteTable(
  'model_calls',
  {
    id: text('id').primaryKey(),
    runId: text('run_id'),
    round: integer('round'),
    role: text('role').notNull(),
    modelId: text('model_id').notNull(),
    billing: text('billing').notNull(),
    at: text('at').notNull(),
    outcome: text('outcome').notNull(),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    cacheReadTokens: integer('cache_read_tokens'),
    cacheWriteTokens: integer('cache_write_tokens'),
    reasoningTokens: integer('reasoning_tokens'),
    costUsd: real('cost_usd'),
    estimateChars: integer('estimate_chars'),
    estimateCharsPerToken: real('estimate_chars_per_token'),
    estimateTokens: integer('estimate_tokens'),
    actualInputTokens: integer('actual_input_tokens'),
    latencyMs: integer('latency_ms').notNull().default(0),
    maxOutputTokens: integer('max_output_tokens'),
    system: text('system'),
    prompt: text('prompt'),
    responseJson: text('response_json'),
    error: text('error'),
    warningsJson: text('warnings_json').notNull().default('[]'),
    /** `trace` for a call this host made; `import` for a row taken over from data/spend.jsonl. */
    source: text('source').notNull().default('trace'),
  },
  (t) => [
    index('model_calls_billing_at').on(t.billing, t.at),
    index('model_calls_model_billing_at').on(t.modelId, t.billing, t.at),
    index('model_calls_run_at').on(t.runId, t.at),
  ],
);

/** The models a run actually used, one row per role plus the bidder and the fallback. */
export const agentConfigs = sqliteTable('agent_configs', {
  /** `${runId}:${kind}` or `${runId}:role:${role}`. */
  id: text('id').primaryKey(),
  runId: text('run_id')
    .notNull()
    .references(() => runs.id),
  kind: text('kind').notNull(),
  role: text('role'),
  alias: text('alias').notNull(),
  provider: text('provider').notNull(),
  model: text('model').notNull(),
  think: integer('think', { mode: 'boolean' }),
  numCtx: integer('num_ctx'),
  charsPerToken: real('chars_per_token'),
});
