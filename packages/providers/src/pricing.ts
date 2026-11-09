import { PriceTableSchema, type ModelPricing, type PriceTable } from '@team/core';

// Anthropic list prices per million tokens, checked against
// https://platform.claude.com/docs/en/about-claude/pricing on the `asOf` date.
// Prices are data (docs/budget-guardrails.md §2): update the numbers and the date
// together. Hosts warn when the table is older than PRICE_TABLE_STALE_AFTER_DAYS.
//
// Haiku 5.5 bills by prompt length: one rate card up to 100K prompt tokens and a
// five-times-dearer one above. Cache reads are a tenth of the input rate on Haiku and
// Sonnet-class models; five-minute cache writes are 1.25x input everywhere.
export const PRICE_TABLE: PriceTable = PriceTableSchema.parse({
  asOf: '2026-11-09',
  models: {
    'claude-opus-5-5': {
      tiers: [
        {
          upToPromptTokens: null,
          inputPerMTok: 4,
          outputPerMTok: 20,
          cacheReadPerMTok: 0.2,
          cacheWritePerMTok: 5,
        },
      ],
    },
    'claude-sonnet-5-5': {
      tiers: [
        {
          upToPromptTokens: null,
          inputPerMTok: 2,
          outputPerMTok: 10,
          cacheReadPerMTok: 0.2,
          cacheWritePerMTok: 2.5,
        },
      ],
    },
    'claude-haiku-5-5': {
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
    },
  },
});

/** Pricing for an API model id, or undefined when the table does not know it. */
export const pricingFor = (modelId: string): ModelPricing | undefined =>
  PRICE_TABLE.models[modelId];
