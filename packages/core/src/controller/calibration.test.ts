import { describe, expect, it } from 'vitest';

import {
  CALIBRATION_MIN_SAMPLES,
  CALIBRATION_SAFETY_FACTOR,
  CALIBRATION_WINDOW,
  calibrateCharsPerToken,
  type CalibrationSample,
} from './calibration';

const sample = (chars: number, tokens: number): CalibrationSample => ({ chars, tokens });

describe('calibrateCharsPerToken', () => {
  it('keeps the fallback until there are enough usable samples', () => {
    const few = Array.from({ length: CALIBRATION_MIN_SAMPLES - 1 }, () => sample(3_000, 1_000));
    expect(calibrateCharsPerToken([], 2)).toBe(2);
    expect(calibrateCharsPerToken(few, 2)).toBe(2);
    // Samples without a count on both sides do not count towards the minimum.
    const padded = [...few, sample(3_000, 0), sample(0, 100)];
    expect(calibrateCharsPerToken(padded, 2)).toBe(2);
    expect(calibrateCharsPerToken([...few, sample(3_000, 1_000)], 2)).not.toBe(2);
  });

  it('pools characters over tokens and takes 15 % off for safety', () => {
    // 3 000 chars for 1 000 tokens, five times: observed 3.0 → 3 / 1.15.
    const samples = Array.from({ length: 5 }, () => sample(3_000, 1_000));
    expect(calibrateCharsPerToken(samples, 9)).toBeCloseTo(3 / CALIBRATION_SAFETY_FACTOR, 3);
    // Pooled, not averaged: the big call dominates.
    const mixed = [
      sample(100, 100),
      sample(100, 100),
      sample(100, 100),
      sample(100, 100),
      sample(10_000, 2_000),
    ];
    expect(calibrateCharsPerToken(mixed, 9)).toBeCloseTo(
      10_400 / 2_400 / CALIBRATION_SAFETY_FACTOR,
      3,
    );
  });

  it('only looks at the newest fifty samples', () => {
    const old = Array.from({ length: 10 }, () => sample(10_000, 1_000));
    const recent = Array.from({ length: CALIBRATION_WINDOW }, () => sample(2_300, 1_000));
    expect(calibrateCharsPerToken([...old, ...recent], 9)).toBeCloseTo(2, 3);
  });

  it('clamps nonsense to the sanity bounds and rounds to three decimals', () => {
    expect(
      calibrateCharsPerToken(
        Array.from({ length: 5 }, () => sample(1, 1_000)),
        3,
      ),
    ).toBe(1);
    expect(
      calibrateCharsPerToken(
        Array.from({ length: 5 }, () => sample(100_000, 1)),
        3,
      ),
    ).toBe(8);
    const value = calibrateCharsPerToken(
      Array.from({ length: 5 }, () => sample(1_000, 300)),
      3,
    );
    expect(String(value).split('.')[1]?.length ?? 0).toBeLessThanOrEqual(3);
  });
});
