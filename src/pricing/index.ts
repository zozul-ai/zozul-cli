/**
 * Claude model pricing per million tokens.
 * Cache creation uses 5-minute TTL pricing (the default for Claude Code).
 */
interface ModelPricing {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
}

// Prices per million tokens
const PRICING: Record<string, ModelPricing> = {
  "claude-opus-4-6":           { input: 5.00,  output: 25.00, cacheRead: 0.50, cacheCreation: 6.25 },
  "claude-sonnet-4-6":         { input: 3.00,  output: 15.00, cacheRead: 0.30, cacheCreation: 3.75 },
  "claude-sonnet-4-5-20250514":{ input: 3.00,  output: 15.00, cacheRead: 0.30, cacheCreation: 3.75 },
  "claude-haiku-4-5-20251001": { input: 1.00,  output: 5.00,  cacheRead: 0.10, cacheCreation: 1.25 },
  "claude-3-5-haiku-20241022": { input: 0.80,  output: 4.00,  cacheRead: 0.08, cacheCreation: 1.00 },
};

function findPricing(model: string): ModelPricing | null {
  if (PRICING[model]) return PRICING[model];
  // Fuzzy match: try prefix matching for versioned model names
  for (const [key, pricing] of Object.entries(PRICING)) {
    if (model.startsWith(key) || key.startsWith(model)) return pricing;
  }
  // Match by family name
  if (model.includes("opus")) return PRICING["claude-opus-4-6"];
  if (model.includes("sonnet")) return PRICING["claude-sonnet-4-6"];
  if (model.includes("haiku")) return PRICING["claude-haiku-4-5-20251001"];
  return null;
}

export function computeTurnCost(
  model: string | null,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number,
  cacheCreationTokens: number,
): number {
  if (!model) return 0;
  const pricing = findPricing(model);
  if (!pricing) return 0;

  return (
    (inputTokens * pricing.input) / 1_000_000 +
    (outputTokens * pricing.output) / 1_000_000 +
    (cacheReadTokens * pricing.cacheRead) / 1_000_000 +
    (cacheCreationTokens * pricing.cacheCreation) / 1_000_000
  );
}
