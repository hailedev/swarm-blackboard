import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { ModelPricing } from '../schemas/pricing';
import {
  estimateInput,
  estimateInputTokens,
  fitCall,
  MIN_OUTPUT_TOKENS,
  SCHEMA_FALLBACK_CHARS,
  schemaChars,
  estimateUndershot,
} from './reservation';

// $1 in, $5 out, cache writes at 1.25x: the prompt is charged at $1.25 per MTok.
const pricing: ModelPricing = {
  tiers: [
    {
      upToPromptTokens: null,
      inputPerMTok: 1,
      outputPerMTok: 5,
      cacheReadPerMTok: 0.1,
      cacheWritePerMTok: 1.25,
    },
  ],
};

describe('estimateInput', () => {
  const Schema = z.object({ answer: z.enum(['yes', 'no']) });
  const json = JSON.stringify(z.toJSONSchema(Schema));

  it('counts the system prompt, the prompt and the serialised schema at the model’s rate', () => {
    const estimate = estimateInput({ system: 'abc', prompt: 'defg', schema: Schema }, 2);
    expect(estimate).toEqual({
      chars: 7 + json.length,
      charsPerToken: 2,
      tokens: Math.ceil((7 + json.length) / 2),
    });
    expect(estimateInputTokens({ system: 'abc', prompt: 'defg', schema: Schema }, 3)).toBe(
      Math.ceil((7 + json.length) / 3),
    );
  });

  it('charges a flat allowance for a schema it cannot render, or none at all', () => {
    expect(schemaChars(Schema)).toBe(json.length);
    expect(schemaChars(undefined)).toBe(SCHEMA_FALLBACK_CHARS);
    const opaque = z.custom<string>((v) => typeof v === 'string');
    expect(schemaChars(opaque)).toBe(SCHEMA_FALLBACK_CHARS);
    expect(estimateInputTokens({ system: '', prompt: '' }, 3)).toBe(SCHEMA_FALLBACK_CHARS / 3);
  });

  it('grows the estimate as the handle enum grows', () => {
    const small = z.object({ parents: z.array(z.enum(['P1'])) });
    const large = z.object({
      parents: z.array(z.enum(Array.from({ length: 120 }, (_, i) => `H${String(i + 1)}`))),
    });
    expect(schemaChars(large)).toBeGreaterThan(schemaChars(small) + 500);
  });
});

describe('fitCall', () => {
  // 1000 prompt tokens cost $0.00125 worst case; each output token costs $0.000005.
  const inputTokens = 1000;

  it('passes the request through when the worst case fits', () => {
    const fit = fitCall({ pricing, inputTokens, maxOutputTokens: 4096, remainingUsd: 0.25 });
    expect(fit).toEqual({
      fits: true,
      maxOutputTokens: 4096,
      worstCaseUsd: expect.closeTo(0.00125 + 4096 * 0.000005, 12) as number,
      shrunk: false,
    });
  });

  it('shrinks the output allowance to what the remaining budget can pay for', () => {
    const fit = fitCall({ pricing, inputTokens, maxOutputTokens: 4096, remainingUsd: 0.005 });
    // (0.005 - 0.00125) / 0.000005 = 750 output tokens.
    expect(fit).toEqual({
      fits: true,
      maxOutputTokens: 750,
      worstCaseUsd: expect.closeTo(0.00125 + 750 * 0.000005, 12) as number,
      shrunk: true,
    });
  });

  it('refuses the call below the output floor and reports the smallest useful cost', () => {
    const fit = fitCall({ pricing, inputTokens, maxOutputTokens: 4096, remainingUsd: 0.002 });
    // (0.002 - 0.00125) / 0.000005 = 150 < 256.
    expect(fit).toEqual({
      fits: false,
      remainingUsd: 0.002,
      worstCaseUsd: expect.closeTo(0.00125 + MIN_OUTPUT_TOKENS * 0.000005, 12) as number,
    });
    expect(fitCall({ pricing, inputTokens, maxOutputTokens: 4096, remainingUsd: 0 }).fits).toBe(
      false,
    );
  });

  it('never grants more than was requested', () => {
    const fit = fitCall({ pricing, inputTokens, maxOutputTokens: 300, remainingUsd: 0.0027 });
    // Affordable 290, requested 300: 290 and shrunk.
    expect(fit.fits && fit.maxOutputTokens).toBe(290);
    const exact = fitCall({ pricing, inputTokens, maxOutputTokens: 300, remainingUsd: 0.00275 });
    expect(exact).toMatchObject({ fits: true, maxOutputTokens: 300, shrunk: false });
  });

  it('treats free models as always fitting, with nothing to reserve', () => {
    expect(fitCall({ pricing: null, inputTokens, maxOutputTokens: 4096, remainingUsd: 0 })).toEqual(
      {
        fits: true,
        maxOutputTokens: 4096,
        worstCaseUsd: 0,
        shrunk: false,
      },
    );
  });

  it('refuses when output is free but the prompt alone does not fit', () => {
    const inputOnly: ModelPricing = {
      tiers: [{ ...pricing.tiers[0], upToPromptTokens: null, outputPerMTok: 0 }],
    } as ModelPricing;
    const fit = fitCall({
      pricing: inputOnly,
      inputTokens,
      maxOutputTokens: 100,
      remainingUsd: 0.001,
    });
    expect(fit.fits).toBe(false);
  });
});

describe('estimateUndershot', () => {
  it('flags only an actual prompt more than 20% above the estimate', () => {
    expect(estimateUndershot(1000, 1200)).toBe(false);
    expect(estimateUndershot(1000, 1201)).toBe(true);
    expect(estimateUndershot(1000, 900)).toBe(false);
    expect(estimateUndershot(0, 1)).toBe(true);
  });
});
