// Per-model calibration of the input-token estimate (docs/budget-guardrails.md §2). The
// estimate divides the characters a call sends by a chars-per-token figure; the figure
// starts at a provider default and, once a model has enough recorded calls, comes from
// what that model actually counted. Hosts read the samples from stored traces; this
// module only does the arithmetic.

/** The newest calls considered. */
export const CALIBRATION_WINDOW = 50;
/** The estimate is made this much more conservative than the pooled observation. */
export const CALIBRATION_SAFETY_FACTOR = 1.15;
/** Below this many usable samples the provider default stands. */
export const CALIBRATION_MIN_SAMPLES = 5;
/** Sanity bounds on chars per token: outside them the samples are not to be trusted. */
export const CHARS_PER_TOKEN_BOUNDS = { min: 1, max: 8 } as const;

export interface CalibrationSample {
  /** Characters the estimator counted for the call: system, prompt and schema. */
  chars: number;
  /** Prompt tokens the provider reported, cache reads and writes included. */
  tokens: number;
}

const round = (value: number, places: number): number => {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
};

/**
 * Pooled chars per token over the last `CALIBRATION_WINDOW` usable samples, divided by the
 * safety factor so the estimate lands about 15 % above what the samples saw. Samples are
 * oldest first; those without a positive count on both sides are ignored.
 */
export const calibrateCharsPerToken = (
  samples: readonly CalibrationSample[],
  fallback: number,
): number => {
  const usable = samples.filter((s) => s.chars > 0 && s.tokens > 0).slice(-CALIBRATION_WINDOW);
  if (usable.length < CALIBRATION_MIN_SAMPLES) return fallback;
  let chars = 0;
  let tokens = 0;
  for (const sample of usable) {
    chars += sample.chars;
    tokens += sample.tokens;
  }
  const observed = chars / tokens / CALIBRATION_SAFETY_FACTOR;
  return round(
    Math.min(CHARS_PER_TOKEN_BOUNDS.max, Math.max(CHARS_PER_TOKEN_BOUNDS.min, observed)),
    3,
  );
};
