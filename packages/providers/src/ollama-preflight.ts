import { err, ok, type Result } from '@team/core';
import { z, type ZodType } from 'zod';

import { ollamaApiUrl } from './ollama';

// Checks a host runs before spending anything against an Ollama server: is it reachable,
// are the tags pulled, and is each model loaded so the first real call does not pay the
// cold load. Also the raw `format` probe the local-model trial uses. Everything that
// talks to a model lives in this package (CLAUDE.md architecture rule 6).

export type Fetch = typeof globalThis.fetch;

export interface OllamaPreflightOptions {
  baseUrl: string;
  models: readonly string[];
  fetch?: Fetch;
  /** For the version and show calls. */
  timeoutMs?: number;
  /** For the warm-up load of each model. */
  loadTimeoutMs?: number;
  /** How long Ollama keeps a warmed model resident. */
  keepAlive?: string;
  /** Skip the warm-up (the trial warms models itself in its own order). */
  warm?: boolean;
}

export type OllamaPreflightError =
  | { kind: 'unreachable'; baseUrl: string; message: string }
  | { kind: 'missing_model'; model: string }
  | { kind: 'load_failed'; model: string; message: string };

export interface OllamaPreflightReport {
  version: string;
  models: readonly string[];
}

const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : 'unknown error';

const post = async (
  fetchFn: Fetch,
  url: string,
  body: unknown,
  timeoutMs: number,
): Promise<Response> =>
  fetchFn(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });

export const preflightOllama = async (
  options: OllamaPreflightOptions,
): Promise<Result<OllamaPreflightReport, OllamaPreflightError>> => {
  const fetchFn = options.fetch ?? globalThis.fetch;
  const api = ollamaApiUrl(options.baseUrl);
  const timeoutMs = options.timeoutMs ?? 5_000;
  const models = [...new Set(options.models)];

  let version: string;
  try {
    const response = await fetchFn(`${api}/version`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) {
      return err({
        kind: 'unreachable',
        baseUrl: options.baseUrl,
        message: `HTTP ${String(response.status)}`,
      });
    }
    const parsed = z.object({ version: z.string() }).safeParse(await response.json());
    version = parsed.success ? parsed.data.version : 'unknown';
  } catch (cause) {
    return err({ kind: 'unreachable', baseUrl: options.baseUrl, message: messageOf(cause) });
  }

  for (const model of models) {
    try {
      const shown = await post(fetchFn, `${api}/show`, { model }, timeoutMs);
      if (shown.status === 404) return err({ kind: 'missing_model', model });
      if (!shown.ok) {
        return err({ kind: 'load_failed', model, message: `show: HTTP ${String(shown.status)}` });
      }
    } catch (cause) {
      return err({ kind: 'unreachable', baseUrl: options.baseUrl, message: messageOf(cause) });
    }
  }

  if (options.warm ?? true) {
    for (const model of models) {
      try {
        // A generate call without a prompt loads the model and returns at once.
        const loaded = await post(
          fetchFn,
          `${api}/generate`,
          { model, keep_alive: options.keepAlive ?? '15m' },
          options.loadTimeoutMs ?? 180_000,
        );
        if (!loaded.ok) {
          return err({ kind: 'load_failed', model, message: `HTTP ${String(loaded.status)}` });
        }
      } catch (cause) {
        return err({ kind: 'load_failed', model, message: messageOf(cause) });
      }
    }
  }
  return ok({ version, models });
};

export const describeOllamaPreflightError = (error: OllamaPreflightError): string => {
  switch (error.kind) {
    case 'unreachable':
      return `Ollama is unreachable at ${error.baseUrl} (${error.message}); is the server awake and OLLAMA_BASE_URL right?`;
    case 'missing_model':
      return `Ollama has no model "${error.model}"; pull it or change the alias in agents.yaml`;
    case 'load_failed':
      return `Ollama could not load "${error.model}": ${error.message}`;
  }
};

export interface OllamaFormatProbeOptions {
  baseUrl: string;
  model: string;
  /** The output schema, sent as JSON schema in `format` and used to validate the reply. */
  schema: ZodType;
  system: string;
  prompts: readonly string[];
  think?: boolean;
  numCtx?: number;
  numPredict?: number;
  fetch?: Fetch;
  timeoutMs?: number;
  now?: () => number;
}

export interface OllamaFormatProbeResult {
  prompt: string;
  /** The HTTP call succeeded. */
  ok: boolean;
  /** The reply parsed as JSON. */
  json: boolean;
  /** The parsed reply satisfied the schema: `format` was honoured. */
  valid: boolean;
  doneReason: string | null;
  text: string;
  promptEvalCount: number | null;
  evalCount: number | null;
  latencyMs: number;
  error: string | null;
}

const ChatReplySchema = z.object({
  message: z.object({ content: z.string() }),
  done_reason: z.string().optional(),
  prompt_eval_count: z.number().optional(),
  eval_count: z.number().optional(),
});

/** Calls /api/chat directly with the schema as `format`, once per prompt. */
export const probeOllamaFormat = async (
  options: OllamaFormatProbeOptions,
): Promise<OllamaFormatProbeResult[]> => {
  const fetchFn = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const format = z.toJSONSchema(options.schema);
  const results: OllamaFormatProbeResult[] = [];
  for (const prompt of options.prompts) {
    const startedMs = now();
    const base = { prompt, latencyMs: 0, promptEvalCount: null, evalCount: null, doneReason: null };
    try {
      const response = await post(
        fetchFn,
        `${ollamaApiUrl(options.baseUrl)}/chat`,
        {
          model: options.model,
          messages: [
            { role: 'system', content: options.system },
            { role: 'user', content: prompt },
          ],
          stream: false,
          format,
          think: options.think ?? false,
          options: {
            num_ctx: options.numCtx ?? 32_768,
            num_predict: options.numPredict ?? 4_096,
          },
        },
        options.timeoutMs ?? 300_000,
      );
      const latencyMs = Math.max(0, now() - startedMs);
      if (!response.ok) {
        results.push({
          ...base,
          latencyMs,
          ok: false,
          json: false,
          valid: false,
          text: '',
          error: `HTTP ${String(response.status)}`,
        });
        continue;
      }
      const reply = ChatReplySchema.safeParse(await response.json());
      if (!reply.success) {
        results.push({
          ...base,
          latencyMs,
          ok: false,
          json: false,
          valid: false,
          text: '',
          error: 'unexpected reply shape',
        });
        continue;
      }
      const text = reply.data.message.content;
      let parsed: unknown;
      let json = true;
      try {
        parsed = JSON.parse(text);
      } catch {
        json = false;
      }
      const valid = json && options.schema.safeParse(parsed).success;
      results.push({
        prompt,
        ok: true,
        json,
        valid,
        doneReason: reply.data.done_reason ?? null,
        text,
        promptEvalCount: reply.data.prompt_eval_count ?? null,
        evalCount: reply.data.eval_count ?? null,
        latencyMs,
        error: null,
      });
    } catch (cause) {
      results.push({
        ...base,
        latencyMs: Math.max(0, now() - startedMs),
        ok: false,
        json: false,
        valid: false,
        text: '',
        error: messageOf(cause),
      });
    }
  }
  return results;
};
