import type { ModelError } from '@team/core';

// Maps whatever the SDK or the network throws onto the typed error kinds the controller
// acts on (docs/budget-guardrails.md §4). Classification is structural, so it works on
// the AI SDK's APICallError, the vendor SDK's errors and plain fetch failures alike.

// Anthropic reports an exhausted credit balance or a Console spend limit as a 400 with a
// telling message, and some billing failures as a 402 `billing_error`. Either way the
// request will keep failing until a human acts, so no retry and no fallback.
const BILLING_PATTERN =
  /credit balance|billing|spend(?:ing)? limit|purchase credits|plans? (?:&|and) billing|payment required/i;

const NETWORK_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  'ABORT_ERR',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
]);

// "Cannot connect to API" is how the AI SDK reports a failed fetch, whatever the cause.
const NETWORK_MESSAGE =
  /fetch failed|cannot connect to api|network|socket hang up|timed? ?out|ECONN|ENOTFOUND/i;

interface ErrorShape {
  name: string | undefined;
  message: string;
  status: number | undefined;
  code: string | undefined;
  type: string | undefined;
  responseBody: string | undefined;
  cause: unknown;
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;

const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const num = (value: unknown): number | undefined => (typeof value === 'number' ? value : undefined);

const shapeOf = (error: unknown): ErrorShape => {
  const record = asRecord(error);
  if (record === undefined) {
    return {
      name: undefined,
      message: typeof error === 'string' ? error : 'unknown error',
      status: undefined,
      code: undefined,
      type: undefined,
      responseBody: undefined,
      cause: undefined,
    };
  }
  return {
    name: str(record['name']),
    message: str(record['message']) ?? 'unknown error',
    status: num(record['statusCode']) ?? num(record['status']),
    code: str(record['code']),
    type: str(record['type']),
    responseBody: str(record['responseBody']),
    cause: record['cause'],
  };
};

const looksLikeNetworkFailure = (error: unknown, depth = 0): boolean => {
  if (depth > 4) return false;
  const shape = shapeOf(error);
  if (shape.name === 'AbortError' || shape.name === 'TimeoutError') return true;
  if (shape.code !== undefined && NETWORK_CODES.has(shape.code)) return true;
  if (NETWORK_MESSAGE.test(shape.message)) return true;
  return shape.cause !== undefined && looksLikeNetworkFailure(shape.cause, depth + 1);
};

export const classifyProviderError = (error: unknown): ModelError => {
  const shape = shapeOf(error);
  const { message, status } = shape;
  const text = `${message} ${shape.responseBody ?? ''} ${shape.type ?? ''}`;
  if (status === 402 || BILLING_PATTERN.test(text)) return { kind: 'billing', message };
  if (status === 401 || status === 403) return { kind: 'auth', message };
  if (status === 429) return { kind: 'rate_limit', message, attempts: 1 };
  if (status !== undefined && status >= 500) return { kind: 'overloaded', message, attempts: 1 };
  if (status !== undefined) return { kind: 'invalid_request', message };
  if (looksLikeNetworkFailure(error)) return { kind: 'network', message, attempts: 1 };
  return { kind: 'invalid_request', message };
};
