import { describe, expect, it } from 'vitest';

import { classifyProviderError } from './errors';

// Shaped like the AI SDK's APICallError: statusCode, message, responseBody, isRetryable.
const apiError = (statusCode: number, message: string, responseBody?: string) => ({
  name: 'AI_APICallError',
  message,
  statusCode,
  responseBody,
  isRetryable: statusCode === 429 || statusCode >= 500,
});

describe('classifyProviderError', () => {
  it.each([
    ['a 402', apiError(402, 'Payment required'), 'billing'],
    [
      'a 400 about credits',
      apiError(
        400,
        'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.',
      ),
      'billing',
    ],
    [
      'a 429 about the spend limit',
      apiError(429, 'This request would exceed your organization’s monthly spend limit.'),
      'billing',
    ],
    [
      'a billing_error body',
      apiError(400, 'bad request', '{"type":"error","error":{"type":"billing_error"}}'),
      'billing',
    ],
    ['a 401', apiError(401, 'invalid x-api-key'), 'auth'],
    ['a 403', apiError(403, 'permission_error'), 'auth'],
    ['a 429', apiError(429, 'rate_limit_error: too many requests'), 'rate_limit'],
    ['a 529', apiError(529, 'overloaded_error'), 'overloaded'],
    ['a 500', apiError(500, 'api_error'), 'overloaded'],
    ['a 400', apiError(400, 'max_tokens: must be positive'), 'invalid_request'],
    ['a 404', apiError(404, 'model: not found'), 'invalid_request'],
    ['a 413', apiError(413, 'request_too_large'), 'invalid_request'],
    ['a 422', apiError(422, 'unprocessable'), 'invalid_request'],
  ])('classifies %s as %s', (_label, error, kind) => {
    expect(classifyProviderError(error).kind).toBe(kind);
  });

  it('classifies transport failures as network, looking through causes', () => {
    const refused = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:11434'), {
        code: 'ECONNREFUSED',
      }),
    });
    expect(classifyProviderError(refused)).toEqual({
      kind: 'network',
      message: 'fetch failed',
      attempts: 1,
    });
    expect(classifyProviderError(Object.assign(new Error('x'), { code: 'ENOTFOUND' })).kind).toBe(
      'network',
    );
    expect(
      classifyProviderError(Object.assign(new Error('aborted'), { name: 'AbortError' })).kind,
    ).toBe('network');
    expect(
      classifyProviderError(
        Object.assign(new Error('The operation timed out'), { name: 'TimeoutError' }),
      ).kind,
    ).toBe('network');
    expect(classifyProviderError(new Error('socket hang up')).kind).toBe('network');
  });

  it('falls back to invalid_request for anything it cannot place, keeping the message', () => {
    expect(classifyProviderError(new Error('something odd'))).toEqual({
      kind: 'invalid_request',
      message: 'something odd',
    });
    expect(classifyProviderError('plain string')).toEqual({
      kind: 'invalid_request',
      message: 'plain string',
    });
    expect(classifyProviderError(undefined)).toEqual({
      kind: 'invalid_request',
      message: 'unknown error',
    });
  });

  it('retryable kinds start at one attempt', () => {
    expect(classifyProviderError(apiError(429, 'slow down'))).toEqual({
      kind: 'rate_limit',
      message: 'slow down',
      attempts: 1,
    });
  });
});

describe('classifyProviderError: SDK connection failures', () => {
  it('treats the SDK message "Cannot connect to API" as a network failure', () => {
    expect(
      classifyProviderError({
        name: 'AI_APICallError',
        message: 'Cannot connect to API: bad port',
        isRetryable: true,
        cause: new Error('bad port'),
      }),
    ).toEqual({ kind: 'network', message: 'Cannot connect to API: bad port', attempts: 1 });
  });
});
