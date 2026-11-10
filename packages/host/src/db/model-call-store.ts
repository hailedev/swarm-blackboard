import {
  CALIBRATION_WINDOW,
  calibrateCharsPerToken,
  isPaidProvider,
  ModelCallTraceSchema,
  nullLogger,
  type CalibrationSample,
  type IdGenerator,
  type Logger,
  type ModelCallTrace,
  type ResolvedModel,
  type TraceSink,
} from '@team/core';
import { and, desc, eq, isNotNull } from 'drizzle-orm';

import type { Db } from './open';
import { modelCalls } from './schema';

// Every traced model call lands in `model_calls` (CLAUDE.md architecture rule 6): the
// spend ledger sums it, the trace viewer reads it, and the chars-per-token calibration
// learns from it (docs/budget-guardrails.md §2). The sink never throws into the model
// call that produced the trace; a failed write is logged instead.

export type ModelCallRow = typeof modelCalls.$inferSelect;

/** A call without its prompt and response bodies, for lists. */
export type ModelCallSummary = Omit<ModelCallRow, 'system' | 'prompt' | 'responseJson'>;

export interface ModelCallStoreOptions {
  ids: IdGenerator;
  logger?: Logger;
}

const summaryColumns = {
  id: modelCalls.id,
  runId: modelCalls.runId,
  round: modelCalls.round,
  role: modelCalls.role,
  modelId: modelCalls.modelId,
  billing: modelCalls.billing,
  at: modelCalls.at,
  outcome: modelCalls.outcome,
  inputTokens: modelCalls.inputTokens,
  outputTokens: modelCalls.outputTokens,
  cacheReadTokens: modelCalls.cacheReadTokens,
  cacheWriteTokens: modelCalls.cacheWriteTokens,
  reasoningTokens: modelCalls.reasoningTokens,
  costUsd: modelCalls.costUsd,
  estimateChars: modelCalls.estimateChars,
  estimateCharsPerToken: modelCalls.estimateCharsPerToken,
  estimateTokens: modelCalls.estimateTokens,
  actualInputTokens: modelCalls.actualInputTokens,
  latencyMs: modelCalls.latencyMs,
  maxOutputTokens: modelCalls.maxOutputTokens,
  error: modelCalls.error,
  warningsJson: modelCalls.warningsJson,
  source: modelCalls.source,
};

export class ModelCallStore {
  readonly #db: Db;
  readonly #ids: IdGenerator;
  readonly #logger: Logger;

  constructor(db: Db, options: ModelCallStoreOptions) {
    this.#db = db;
    this.#ids = options.ids;
    this.#logger = options.logger ?? nullLogger;
  }

  /** The TraceSink for the model factory: records, and logs rather than throws. */
  readonly sink: TraceSink = (trace) => {
    try {
      this.record(trace);
    } catch (cause) {
      this.#logger.error('model call not recorded', {
        modelId: trace.modelId,
        runId: trace.tags.runId,
        message: cause instanceof Error ? cause.message : 'unknown error',
      });
    }
  };

  /** Insert one trace. Validates the shape first so a bad row never reaches the ledger. */
  record(trace: ModelCallTrace): string {
    const parsed = ModelCallTraceSchema.parse(trace);
    const id = this.#ids.next();
    this.#db
      .insert(modelCalls)
      .values({
        id,
        runId: parsed.tags.runId,
        round: parsed.tags.round,
        role: parsed.tags.role,
        modelId: parsed.modelId,
        billing: parsed.billing,
        at: parsed.at,
        outcome: parsed.outcome,
        inputTokens: parsed.usage?.inputTokens ?? null,
        outputTokens: parsed.usage?.outputTokens ?? null,
        cacheReadTokens: parsed.usage?.cacheReadTokens ?? null,
        cacheWriteTokens: parsed.usage?.cacheWriteTokens ?? null,
        reasoningTokens: parsed.usage?.reasoningTokens ?? null,
        costUsd: parsed.usage?.costUsd ?? null,
        estimateChars: parsed.estimate.chars,
        estimateCharsPerToken: parsed.estimate.charsPerToken,
        estimateTokens: parsed.estimate.tokens,
        actualInputTokens: parsed.actualInputTokens,
        latencyMs: parsed.latencyMs,
        maxOutputTokens: parsed.request.maxOutputTokens,
        system: parsed.request.system,
        prompt: parsed.request.prompt,
        responseJson: parsed.response === undefined ? null : JSON.stringify(parsed.response),
        error: parsed.error,
        warningsJson: JSON.stringify(parsed.warnings),
        source: 'trace',
      })
      .run();
    return id;
  }

  /**
   * The newest API-billed calls of a model that reported a prompt count, oldest first,
   * as the calibration wants them (docs/budget-guardrails.md §2).
   */
  calibrationSamples(modelId: string, limit = CALIBRATION_WINDOW): CalibrationSample[] {
    const rows = this.#db
      .select({ chars: modelCalls.estimateChars, tokens: modelCalls.actualInputTokens })
      .from(modelCalls)
      .where(
        and(
          eq(modelCalls.modelId, modelId),
          eq(modelCalls.billing, 'api'),
          isNotNull(modelCalls.estimateChars),
          isNotNull(modelCalls.actualInputTokens),
        ),
      )
      .orderBy(desc(modelCalls.at))
      .limit(limit)
      .all();
    return rows
      .flatMap((row) =>
        row.chars === null || row.tokens === null ? [] : [{ chars: row.chars, tokens: row.tokens }],
      )
      .reverse();
  }

  /**
   * The factory's chars-per-token lookup: calibrated from this store for paid models,
   * the provider default for local ones (Ollama's prompt counts are not trustworthy
   * after a KV-cache hit, and the local estimate only guards the context window).
   */
  charsPerToken(resolved: ResolvedModel, providerDefault: number): number | undefined {
    if (!isPaidProvider(resolved.provider)) return undefined;
    return calibrateCharsPerToken(this.calibrationSamples(resolved.model), providerDefault);
  }

  /** Calls of one run in time order, without bodies. */
  forRun(runId: string): ModelCallSummary[] {
    return this.#db
      .select(summaryColumns)
      .from(modelCalls)
      .where(eq(modelCalls.runId, runId))
      .orderBy(modelCalls.at)
      .all();
  }

  byId(id: string): ModelCallRow | undefined {
    return this.#db.select().from(modelCalls).where(eq(modelCalls.id, id)).get();
  }
}
