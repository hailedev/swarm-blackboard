import { z } from 'zod';

import type { Usage } from './common';

// Prices are data, not code (docs/budget-guardrails.md §2). The table itself lives in
// packages/providers; core only knows the shape and how to turn usage into dollars.
//
// A model may bill by prompt length: Haiku 5.5 charges one rate card up to 100K prompt
// tokens and a dearer one above. Tiers are ordered by `upToPromptTokens`; the last tier
// has `null` and catches everything larger. The tier is chosen by the prompt size and
// applies to every token of the call, which is how the vendor bills it.
export const PriceTierSchema = z.object({
  upToPromptTokens: z.int().positive().nullable(),
  inputPerMTok: z.number().nonnegative(),
  outputPerMTok: z.number().nonnegative(),
  cacheReadPerMTok: z.number().nonnegative(),
  cacheWritePerMTok: z.number().nonnegative(),
});
export type PriceTier = z.infer<typeof PriceTierSchema>;

export const ModelPricingSchema = z.object({
  tiers: z
    .array(PriceTierSchema)
    .min(1)
    .refine((tiers) => tiers.at(-1)?.upToPromptTokens === null, {
      message: 'the last tier must have upToPromptTokens: null',
    })
    .refine(
      (tiers) =>
        tiers.every(
          (tier, index) =>
            index === tiers.length - 1 ||
            (tier.upToPromptTokens !== null &&
              (index === 0 ||
                (tiers[index - 1]?.upToPromptTokens ?? Infinity) < tier.upToPromptTokens)),
        ),
      { message: 'tiers must be in ascending order of upToPromptTokens' },
    ),
});
export type ModelPricing = z.infer<typeof ModelPricingSchema>;

export const PriceTableSchema = z.object({
  /** Date the prices were last checked against the vendor's price list. */
  asOf: z.iso.date(),
  models: z.record(z.string().min(1), ModelPricingSchema),
});
export type PriceTable = z.infer<typeof PriceTableSchema>;

const PER_MTOK = 1_000_000;

export const tierFor = (pricing: ModelPricing, promptTokenCount: number): PriceTier => {
  const tier = pricing.tiers.find(
    (t) => t.upToPromptTokens === null || promptTokenCount <= t.upToPromptTokens,
  );
  // The schema guarantees a final catch-all tier; this fallback only satisfies the types.
  return tier ?? pricing.tiers[pricing.tiers.length - 1] ?? zeroTier;
};

const zeroTier: PriceTier = {
  upToPromptTokens: null,
  inputPerMTok: 0,
  outputPerMTok: 0,
  cacheReadPerMTok: 0,
  cacheWritePerMTok: 0,
};

export type TokenCounts = Omit<Usage, 'costUsd'>;

/** Dollar cost of a call. `null` pricing means a local or fake model: tokens, no money. */
export const costOf = (tokens: TokenCounts, pricing: ModelPricing | null): number => {
  if (pricing === null) return 0;
  const tier = tierFor(
    pricing,
    tokens.inputTokens + tokens.cacheReadTokens + tokens.cacheWriteTokens,
  );
  return (
    (tokens.inputTokens * tier.inputPerMTok +
      tokens.outputTokens * tier.outputPerMTok +
      tokens.cacheReadTokens * tier.cacheReadPerMTok +
      tokens.cacheWriteTokens * tier.cacheWritePerMTok) /
    PER_MTOK
  );
};

export const withCost = (tokens: TokenCounts, pricing: ModelPricing | null): Usage => ({
  ...tokens,
  costUsd: costOf(tokens, pricing),
});

/**
 * The most a call can cost: every prompt token at the dearer of the input and
 * cache-write rates, and the full output allowance. Used for reservations.
 */
export const worstCaseCostUsd = (
  pricing: ModelPricing | null,
  promptTokenCount: number,
  maxOutputTokens: number,
): number => {
  if (pricing === null) return 0;
  const tier = tierFor(pricing, promptTokenCount);
  const promptRate = Math.max(tier.inputPerMTok, tier.cacheWritePerMTok);
  return (promptTokenCount * promptRate + maxOutputTokens * tier.outputPerMTok) / PER_MTOK;
};

/** Marginal cost of one more output token at the given prompt size. */
export const outputTokenCostUsd = (pricing: ModelPricing, promptTokenCount: number): number =>
  tierFor(pricing, promptTokenCount).outputPerMTok / PER_MTOK;

export const PRICE_TABLE_STALE_AFTER_DAYS = 90;

const DAY_MS = 86_400_000;

/** Whole days since the table's `asOf` date. Hosts warn past PRICE_TABLE_STALE_AFTER_DAYS. */
export const priceTableAgeDays = (table: PriceTable, nowMs: number): number =>
  Math.max(0, Math.floor((nowMs - Date.parse(`${table.asOf}T00:00:00.000Z`)) / DAY_MS));
