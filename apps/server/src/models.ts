import {
  AGENT_ROLES,
  err,
  isPaidProvider,
  ok,
  type AgentRole,
  type Logger,
  type Model,
  type ModelPricing,
  type ResolvedModel,
} from '@team/core';
import { createScriptedModels } from '@team/core/testing';
import type { Env } from '@team/host';
import {
  createProfileModels,
  describeProfileModelsError,
  PRICE_TABLE,
  pricingFor,
  traceModel,
} from '@team/providers';

import type { RunModelsSource } from './run-manager';

export const DEFAULT_OLLAMA_BASE_URL = 'http://localhost:11434';

/** Real models for a run: the shared builder, with the Ollama pre-flight logged. */
export const realModels =
  (env: Env, logger: Logger): RunModelsSource =>
  async ({ profile, sink, charsPerToken }) => {
    const built = await createProfileModels(profile, {
      anthropicApiKey: env['ANTHROPIC_API_KEY'],
      ollamaBaseUrl: env['OLLAMA_BASE_URL'] ?? DEFAULT_OLLAMA_BASE_URL,
      priceTable: PRICE_TABLE,
      sink,
      charsPerToken,
      onProgress: (line) => {
        logger.info(line, { profile: profile.name });
      },
    });
    if (!built.ok) return err({ message: describeProfileModelsError(built.error) });
    return ok({ roles: built.value.roles, fallback: built.value.fallback });
  };

/** How long a scripted call takes by default: long enough to watch a round and pause it. */
export const DEFAULT_FAKE_DELAY_MS = 800;

export interface ScriptedModelsOptions {
  /** Held before every scripted call, so a run unfolds at a pace a person can follow. */
  delayMs: number;
  /** Test seam; the default waits on a timer. */
  sleep?: (ms: number) => Promise<void>;
}

const timerSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

// A scripted stand-in carries the price of the model it stands in for, as `pnpm solve
// --fake` does: a free profile stays free, and a paid one moves the cost meter and meets
// the same reservations without anything being billed.
const priceOf = (model: ResolvedModel): ModelPricing | null | undefined =>
  isPaidProvider(model.provider) ? pricingFor(model.model) : null;

/**
 * Scripted models for a run (`--fake`): the canonical scenario of `@team/core/testing`,
 * traced like real calls (billing `fake`, so the monthly ledger never counts them).
 */
export const scriptedModels =
  (options: ScriptedModelsOptions): RunModelsSource =>
  ({ profile, sink, currentView }) => {
    const sleep = options.sleep ?? timerSleep;
    const pricing: Partial<Record<AgentRole, ModelPricing | null>> = {};
    for (const role of AGENT_ROLES) {
      const resolved = profile.roles[role];
      const price = priceOf(resolved);
      if (price === undefined) {
        return Promise.resolve(
          err({
            message: `no price for ${resolved.provider}/${resolved.model} in the price table; add it to packages/providers/src/pricing.ts`,
          }),
        );
      }
      pricing[role] = price;
    }
    const scripted = createScriptedModels(currentView, pricing);
    const paced = (model: Model): Model => ({
      id: model.id,
      billing: model.billing,
      pricing: model.pricing,
      charsPerToken: model.charsPerToken,
      generateObject: async (request) => {
        await sleep(options.delayMs);
        return model.generateObject(request);
      },
    });
    const roles = Object.fromEntries(
      AGENT_ROLES.map((role) => [role, traceModel(paced(scripted[role]), sink)]),
    ) as Record<AgentRole, Model>;
    return Promise.resolve(ok({ roles, fallback: undefined }));
  };
