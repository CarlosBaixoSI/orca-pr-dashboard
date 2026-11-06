/**
 * Prices in US dollars per million tokens, from the Claude API pricing table cached on 2026-10-06.
 * Cache read prices not listed there are assumed to be 0.1x the input price.
 */

const CACHE_WRITE_MULTIPLIERS = { fiveMinutes: 1.25, oneHour: 2 };
const FAST_MODE_MULTIPLIER = 2;
const MODEL_PRICES = {
  'claude-fable-5': { cacheRead: 1, input: 10, output: 50 },
  'claude-fable-5-1': { cacheRead: 0.25, input: 10, output: 50 },
  'claude-haiku-4-5': { cacheRead: 0.1, input: 1, output: 5 },
  'claude-haiku-5-5': { cacheRead: 0.01, input: 0.1, output: 0.5 },
  'claude-mythos-5-1': { cacheRead: 0.25, input: 10, output: 50 },
  'claude-opus-4-6': { cacheRead: 0.5, input: 5, output: 25 },
  'claude-opus-4-7': { cacheRead: 0.5, input: 5, output: 25 },
  'claude-opus-4-8': { cacheRead: 0.5, input: 5, output: 25 },
  'claude-opus-5': { cacheRead: 0.5, input: 5, output: 25 },
  'claude-opus-5-5': { cacheRead: 0.2, input: 4, output: 20 },
  'claude-sonnet-4-6': { cacheRead: 0.3, input: 3, output: 15 },
  'claude-sonnet-5': { cacheRead: 0.2, input: 2, output: 10 },
  'claude-sonnet-5-5': { cacheRead: 0.2, input: 2, output: 10 }
};
const TOKENS_PER_UNIT = 1_000_000;

/**
 * Find the prices of the given model, ignoring context window suffixes such as "[1m]".
 */

function findPrices(model) {
  return MODEL_PRICES[model.replace(/\[.*\]$/, '')] ?? null;
}

/**
 * Compute the estimated cost in US dollars of one API response usage block.
 */

export function computeCost(model, usage) {
  const prices = model ? findPrices(model) : null;

  if (!prices) {
    return 0;
  }

  const cacheCreation = usage.cache_creation;
  const cacheWriteFiveMinutes = cacheCreation
    ? cacheCreation.ephemeral_5m_input_tokens ?? 0
    : usage.cache_creation_input_tokens ?? 0;
  const cacheWriteOneHour = cacheCreation?.ephemeral_1h_input_tokens ?? 0;
  const speedMultiplier = usage.speed === 'fast' ? FAST_MODE_MULTIPLIER : 1;
  const total =
    (usage.input_tokens ?? 0) * prices.input +
    (usage.output_tokens ?? 0) * prices.output +
    (usage.cache_read_input_tokens ?? 0) * prices.cacheRead +
    cacheWriteFiveMinutes * prices.input * CACHE_WRITE_MULTIPLIERS.fiveMinutes +
    cacheWriteOneHour * prices.input * CACHE_WRITE_MULTIPLIERS.oneHour;

  return (total * speedMultiplier) / TOKENS_PER_UNIT;
}
