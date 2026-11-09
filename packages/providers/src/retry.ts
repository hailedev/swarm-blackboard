import { err, RETRYABLE_MODEL_ERRORS, type Model, type ModelError } from '@team/core';

// Retry policy for transient failures (docs/budget-guardrails.md §4 and §6): rate limits,
// overload and network errors get exponential backoff from one second, three attempts in
// all, then the error goes back to the controller with the attempt count so it can pause
// the run. Billing, auth, invalid requests and schema failures are never retried here.
export interface RetryPolicy {
  attempts: number;
  baseDelayMs: number;
  sleep: (ms: number) => Promise<void>;
}

export const DEFAULT_RETRY_POLICY: Omit<RetryPolicy, 'sleep'> = { attempts: 3, baseDelayMs: 1_000 };

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

type RetryableError = Extract<ModelError, { attempts: number }>;

const isRetryable = (error: ModelError): error is RetryableError =>
  RETRYABLE_MODEL_ERRORS.includes(error.kind);

export const backoffDelayMs = (attempt: number, baseDelayMs: number): number =>
  baseDelayMs * 2 ** (attempt - 1);

export const withRetry = (model: Model, policy: Partial<RetryPolicy> = {}): Model => {
  const attempts = policy.attempts ?? DEFAULT_RETRY_POLICY.attempts;
  const baseDelayMs = policy.baseDelayMs ?? DEFAULT_RETRY_POLICY.baseDelayMs;
  const sleep = policy.sleep ?? defaultSleep;
  return {
    id: model.id,
    billing: model.billing,
    pricing: model.pricing,
    charsPerToken: model.charsPerToken,
    async generateObject(request) {
      for (let attempt = 1; ; attempt += 1) {
        const result = await model.generateObject(request);
        if (result.ok || !isRetryable(result.error)) return result;
        if (attempt >= attempts) return err({ ...result.error, attempts: attempt });
        await sleep(backoffDelayMs(attempt, baseDelayMs));
      }
    },
  };
};
