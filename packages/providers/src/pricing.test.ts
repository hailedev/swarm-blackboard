import { costOf, PRICE_TABLE_STALE_AFTER_DAYS, priceTableAgeDays } from '@team/core';
import { describe, expect, it } from 'vitest';

import { PRICE_TABLE, pricingFor } from './pricing';

const tokens = (inputTokens: number, outputTokens: number, cacheReadTokens = 0) => ({
  inputTokens,
  outputTokens,
  cacheReadTokens,
  cacheWriteTokens: 0,
});

describe('PRICE_TABLE', () => {
  it('prices the models agents.yaml can name', () => {
    expect(pricingFor('claude-sonnet-5-5')).toBeDefined();
    expect(pricingFor('claude-haiku-5-5')).toBeDefined();
    expect(pricingFor('qwen3.6:35b-mlx')).toBeUndefined();
  });

  it('charges Sonnet one rate at any prompt length', () => {
    const sonnet = pricingFor('claude-sonnet-5-5') ?? null;
    expect(costOf(tokens(1_000_000, 1_000_000), sonnet)).toBeCloseTo(2 + 10, 10);
    expect(costOf(tokens(1_000_000, 1_000_000, 1_000_000), sonnet)).toBeCloseTo(2 + 10 + 0.2, 10);
  });

  it('charges Haiku five times more once the prompt passes 100K tokens', () => {
    const haiku = pricingFor('claude-haiku-5-5') ?? null;
    const small = costOf(tokens(100_000, 1000), haiku);
    const large = costOf(tokens(100_001, 1000), haiku);
    expect(small).toBeCloseTo((100_000 * 0.1 + 1000 * 0.5) / 1e6, 12);
    expect(large).toBeCloseTo((100_001 * 0.5 + 1000 * 2.5) / 1e6, 12);
    expect(large / small).toBeGreaterThan(4.9);
  });

  // Not a failing test when the date ages: a stale table must never break CI. The CLI
  // and server warn instead. This only checks the helper agrees with the table's date.
  it('dates itself so hosts can warn when it goes stale', () => {
    const asOf = Date.parse(`${PRICE_TABLE.asOf}T00:00:00.000Z`);
    expect(Number.isNaN(asOf)).toBe(false);
    expect(priceTableAgeDays(PRICE_TABLE, asOf)).toBe(0);
    expect(
      priceTableAgeDays(PRICE_TABLE, asOf + (PRICE_TABLE_STALE_AFTER_DAYS + 1) * 86_400_000),
    ).toBeGreaterThan(PRICE_TABLE_STALE_AFTER_DAYS);
  });
});
