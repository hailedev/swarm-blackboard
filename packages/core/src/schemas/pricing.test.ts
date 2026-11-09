import { describe, expect, it } from 'vitest';

import {
  costOf,
  ModelPricingSchema,
  outputTokenCostUsd,
  priceTableAgeDays,
  PriceTableSchema,
  tierFor,
  withCost,
  worstCaseCostUsd,
  type ModelPricing,
} from './pricing';

// Sonnet-shaped: one rate card at any prompt length.
const flat: ModelPricing = {
  tiers: [
    {
      upToPromptTokens: null,
      inputPerMTok: 2,
      outputPerMTok: 10,
      cacheReadPerMTok: 0.2,
      cacheWritePerMTok: 2.5,
    },
  ],
};

// Haiku-shaped: five times dearer once the prompt passes 100K tokens.
const tiered: ModelPricing = {
  tiers: [
    {
      upToPromptTokens: 100_000,
      inputPerMTok: 0.1,
      outputPerMTok: 0.5,
      cacheReadPerMTok: 0.01,
      cacheWritePerMTok: 0.125,
    },
    {
      upToPromptTokens: null,
      inputPerMTok: 0.5,
      outputPerMTok: 2.5,
      cacheReadPerMTok: 0.05,
      cacheWritePerMTok: 0.625,
    },
  ],
};

const tokens = (partial: Partial<Parameters<typeof costOf>[0]>) => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  ...partial,
});

describe('costOf', () => {
  it('prices plain input and output', () => {
    expect(costOf(tokens({ inputTokens: 1_000_000, outputTokens: 100_000 }), flat)).toBeCloseTo(
      2 + 1,
      10,
    );
  });

  it('prices cache reads and writes at their own rates', () => {
    const cost = costOf(
      tokens({
        inputTokens: 1000,
        cacheReadTokens: 10_000,
        cacheWriteTokens: 1000,
        outputTokens: 100,
      }),
      flat,
    );
    expect(cost).toBeCloseTo((1000 * 2 + 10_000 * 0.2 + 1000 * 2.5 + 100 * 10) / 1e6, 12);
  });

  it('switches rate card by prompt length, cache tokens included', () => {
    expect(tierFor(tiered, 100_000).inputPerMTok).toBe(0.1);
    expect(tierFor(tiered, 100_001).inputPerMTok).toBe(0.5);
    const below = costOf(tokens({ inputTokens: 100_000, outputTokens: 1000 }), tiered);
    const above = costOf(
      tokens({ inputTokens: 99_000, cacheReadTokens: 2_000, outputTokens: 1000 }),
      tiered,
    );
    expect(below).toBeCloseTo((100_000 * 0.1 + 1000 * 0.5) / 1e6, 12);
    expect(above).toBeCloseTo((99_000 * 0.5 + 2_000 * 0.05 + 1000 * 2.5) / 1e6, 12);
  });

  it('is zero for local and fake models but keeps the tokens', () => {
    expect(costOf(tokens({ inputTokens: 5000, outputTokens: 500 }), null)).toBe(0);
    expect(withCost(tokens({ inputTokens: 5000, outputTokens: 500 }), null)).toEqual({
      inputTokens: 5000,
      outputTokens: 500,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0,
    });
  });
});

describe('worstCaseCostUsd', () => {
  it('charges the prompt at the dearer of input and cache-write rates plus the full output allowance', () => {
    expect(worstCaseCostUsd(flat, 10_000, 4096)).toBeCloseTo((10_000 * 2.5 + 4096 * 10) / 1e6, 12);
    expect(worstCaseCostUsd(null, 10_000, 4096)).toBe(0);
  });

  it('uses the tier the prompt lands in', () => {
    expect(worstCaseCostUsd(tiered, 200_000, 1000)).toBeCloseTo(
      (200_000 * 0.625 + 1000 * 2.5) / 1e6,
      12,
    );
    expect(outputTokenCostUsd(tiered, 50_000)).toBeCloseTo(0.5 / 1e6, 15);
    expect(outputTokenCostUsd(tiered, 150_000)).toBeCloseTo(2.5 / 1e6, 15);
  });
});

describe('ModelPricingSchema', () => {
  it('requires a final catch-all tier in ascending order', () => {
    expect(ModelPricingSchema.safeParse(flat).success).toBe(true);
    expect(ModelPricingSchema.safeParse(tiered).success).toBe(true);
    expect(ModelPricingSchema.safeParse({ tiers: [] }).success).toBe(false);
    expect(
      ModelPricingSchema.safeParse({ tiers: [{ ...tiered.tiers[0], upToPromptTokens: 100 }] })
        .success,
    ).toBe(false);
    expect(
      ModelPricingSchema.safeParse({ tiers: [tiered.tiers[1], tiered.tiers[0]] }).success,
    ).toBe(false);
    expect(
      ModelPricingSchema.safeParse({
        tiers: [
          { ...tiered.tiers[0], upToPromptTokens: 200 },
          { ...tiered.tiers[0], upToPromptTokens: 100 },
          tiered.tiers[1],
        ],
      }).success,
    ).toBe(false);
  });
});

describe('PriceTableSchema and staleness', () => {
  it('parses a dated table and measures its age in whole days', () => {
    const table = PriceTableSchema.parse({ asOf: '2026-01-01', models: { m: flat } });
    const jan1 = Date.UTC(2026, 0, 1);
    expect(priceTableAgeDays(table, jan1)).toBe(0);
    expect(priceTableAgeDays(table, jan1 + 90 * 86_400_000 - 1)).toBe(89);
    expect(priceTableAgeDays(table, jan1 + 91 * 86_400_000)).toBe(91);
    expect(priceTableAgeDays(table, jan1 - 86_400_000)).toBe(0);
    expect(PriceTableSchema.safeParse({ asOf: 'yesterday', models: {} }).success).toBe(false);
  });
});

describe('pricing that bypassed the schema', () => {
  it('falls back to the last tier, or to free, rather than throwing', () => {
    const noCatchAll: ModelPricing = {
      tiers: [
        {
          upToPromptTokens: 10,
          inputPerMTok: 1,
          outputPerMTok: 1,
          cacheReadPerMTok: 1,
          cacheWritePerMTok: 1,
        },
      ],
    };
    expect(tierFor(noCatchAll, 1_000).inputPerMTok).toBe(1);
    expect(tierFor({ tiers: [] }, 5).outputPerMTok).toBe(0);
  });

  it('rejects a catch-all tier that is not last', () => {
    expect(
      ModelPricingSchema.safeParse({ tiers: [tiered.tiers[1], tiered.tiers[0], tiered.tiers[1]] })
        .success,
    ).toBe(false);
  });
});
