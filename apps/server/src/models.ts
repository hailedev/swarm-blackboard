import { err, ok, type Logger } from '@team/core';
import type { Env } from '@team/host';
import { createProfileModels, describeProfileModelsError, PRICE_TABLE } from '@team/providers';

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
