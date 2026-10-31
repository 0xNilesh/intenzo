import type { ModelUsage } from "./port.ts";

// List prices in USD per million tokens (dev.meta.ai/docs/pricing-rate-limits, read 2026-10-31,
// Standard mode). Cached input tokens are billed at the cached rate, the rest at the input rate;
// reasoning tokens are output tokens.
export const USD_PER_M_TOKENS: Readonly<
  Record<string, { input: number; cached: number; output: number }>
> = {
  "muse-spark-1.3": { input: 1.25, cached: 0.15, output: 4.25 },
  "muse-wonder-1.0": { input: 4, cached: 0.2, output: 20 },
  // Spark Open on Baseten's Model APIs, at its list price (DECISIONS 2026-10-30, T0.3).
  "meta-models/muse-spark-open": { input: 1.25, cached: 0.15, output: 4.25 },
};

/** A call's list-price cost, or null for a model without a known price. */
export function costUsd(model: string, usage: ModelUsage): number | null {
  const price = USD_PER_M_TOKENS[model];
  if (!price) return null;
  const fresh = usage.promptTokens - usage.cachedTokens;
  return (
    (fresh * price.input +
      usage.cachedTokens * price.cached +
      usage.completionTokens * price.output) /
    1e6
  );
}
