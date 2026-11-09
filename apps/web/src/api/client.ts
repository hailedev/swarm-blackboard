import { EntrySchema, type Entry } from '@team/core';
import {
  ApiErrorSchema,
  BudgetResponseSchema,
  ModelCallDetailSchema,
  ProfilesResponseSchema,
  RunListResponseSchema,
  RunRecordSchema,
  TraceResponseSchema,
  type BudgetResponse,
  type InjectNoteBody,
  type ModelCallDetail,
  type ProfilesResponse,
  type RunRecord,
  type StartRunBody,
  type TraceResponse,
} from '@team/server/api';
import type { z } from 'zod';

// The one place the browser talks to the API. Every response is parsed with the server's
// own schema (CLAUDE.md: Zod at every boundary), and every failure becomes an ApiFailure
// carrying the server's error envelope, so callers show the server's words.

/** Requests go through Vite's dev proxy (apps/web/vite.config.ts). */
export const API_BASE = '/api';

export class ApiFailure extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiFailure';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

const readJson = async (response: Response): Promise<unknown> => {
  try {
    return (await response.json()) as unknown;
  } catch {
    return undefined;
  }
};

export const createApiClient = (fetchImpl: Fetch = (input, init) => fetch(input, init)) => {
  const request = async <S extends z.ZodType>(
    schema: S,
    path: string,
    init?: RequestInit,
  ): Promise<z.infer<S>> => {
    let response: Response;
    try {
      response = await fetchImpl(`${API_BASE}${path}`, init);
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : 'network error';
      throw new ApiFailure(0, 'unreachable', `The API server did not answer (${reason}).`);
    }
    const body = await readJson(response);
    if (!response.ok) {
      const envelope = ApiErrorSchema.safeParse(body);
      if (envelope.success) {
        const { code, message, details } = envelope.data.error;
        throw new ApiFailure(response.status, code, message, details);
      }
      throw new ApiFailure(
        response.status,
        'http_error',
        `The API server answered ${String(response.status)} for ${path}.`,
      );
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const where = issue === undefined ? '' : ` at ${issue.path.map(String).join('.')}`;
      throw new ApiFailure(
        response.status,
        'contract',
        `Unexpected response from ${path}${where}: the web app and the server disagree on the contract.`,
      );
    }
    return parsed.data;
  };

  const post = (body?: unknown): RequestInit => ({
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const run = (id: string): string => `/runs/${encodeURIComponent(id)}`;

  return {
    runs: (): Promise<RunRecord[]> =>
      request(RunListResponseSchema, '/runs').then((list) => list.runs),
    run: (id: string): Promise<RunRecord> => request(RunRecordSchema, run(id)),
    profiles: (): Promise<ProfilesResponse> => request(ProfilesResponseSchema, '/profiles'),
    budget: (): Promise<BudgetResponse> => request(BudgetResponseSchema, '/budget'),
    trace: (id: string): Promise<TraceResponse> => request(TraceResponseSchema, `${run(id)}/trace`),
    call: (id: string, callId: string): Promise<ModelCallDetail> =>
      request(ModelCallDetailSchema, `${run(id)}/trace/${encodeURIComponent(callId)}`),
    start: (body: StartRunBody): Promise<RunRecord> =>
      request(RunRecordSchema, '/runs', post(body)),
    pause: (id: string): Promise<RunRecord> => request(RunRecordSchema, `${run(id)}/pause`, post()),
    resume: (id: string): Promise<RunRecord> =>
      request(RunRecordSchema, `${run(id)}/resume`, post()),
    stop: (id: string): Promise<RunRecord> => request(RunRecordSchema, `${run(id)}/stop`, post()),
    synthesize: (id: string): Promise<RunRecord> =>
      request(RunRecordSchema, `${run(id)}/synthesize`, post()),
    inject: (id: string, note: InjectNoteBody): Promise<Entry> =>
      request(EntrySchema, `${run(id)}/notes`, post(note)),
  };
};

export type ApiClient = ReturnType<typeof createApiClient>;

export const api = createApiClient();

/** The message to show for a failed request, whatever was thrown. */
export const failureMessage = (error: unknown): string =>
  error instanceof Error ? error.message : 'Something went wrong.';
