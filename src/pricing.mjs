/**
 * Claude prices in US dollars per million tokens, from the Claude API pricing table cached on 2026-10-06.
 * Cache read prices not listed there are assumed to be 0.1x the input price.
 */

const CACHE_WRITE_MULTIPLIERS = { fiveMinutes: 1.25, oneHour: 2 };
const CLAUDE_MODEL_PRICES = {
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
const FAST_MODE_MULTIPLIER = 2;

/**
 * OpenAI standard short context prices in US dollars per million tokens, from the OpenAI API pricing page read on 2026-11-07.
 * Models without a cached input price are charged the full input price for cached tokens.
 */

const OPENAI_MODEL_PRICES = {
  'gpt-4.1': { cacheRead: 0.5, input: 2, output: 8 },
  'gpt-4.1-mini': { cacheRead: 0.1, input: 0.4, output: 1.6 },
  'gpt-4o': { cacheRead: 1.25, input: 2.5, output: 10 },
  'gpt-4o-mini': { cacheRead: 0.075, input: 0.15, output: 0.6 },
  'gpt-5': { cacheRead: 0.125, input: 1.25, output: 10 },
  'gpt-5-mini': { cacheRead: 0.025, input: 0.25, output: 2 },
  'gpt-5-nano': { cacheRead: 0.005, input: 0.05, output: 0.4 },
  'gpt-5-pro': { cacheRead: 15, input: 15, output: 120 },
  'gpt-5.1': { cacheRead: 0.125, input: 1.25, output: 10 },
  'gpt-5.2': { cacheRead: 0.175, input: 1.75, output: 14 },
  'gpt-5.2-pro': { cacheRead: 21, input: 21, output: 168 },
  'gpt-5.3-codex': { cacheRead: 0.175, input: 1.75, output: 14 },
  'gpt-5.4': { cacheRead: 0.25, input: 2.5, output: 15 },
  'gpt-5.4-mini': { cacheRead: 0.075, input: 0.75, output: 4.5 },
  'gpt-5.4-nano': { cacheRead: 0.02, input: 0.2, output: 1.25 },
  'gpt-5.4-pro': { cacheRead: 30, input: 30, output: 180 },
  'gpt-5.5': { cacheRead: 0.5, input: 5, output: 30 },
  'gpt-5.5-pro': { cacheRead: 30, input: 30, output: 180 },
  'gpt-5.6-luna': { cacheRead: 0.02, input: 0.2, output: 1.2 },
  'gpt-5.6-sol': { cacheRead: 0.4, input: 4, output: 20 },
  'gpt-5.6-terra': { cacheRead: 0.2, input: 2, output: 12 },
  'gpt-6-astra': { cacheRead: 1, input: 10, output: 50 },
  'gpt-6-luna': { cacheRead: 0.01, input: 0.1, output: 0.5 },
  'gpt-6-sol': { cacheRead: 0.2, input: 2, output: 10 },
  'gpt-6.1-sol': { cacheRead: 0.1, input: 2, output: 10 },
  'gpt-6.1-terra': { cacheRead: 0.05, input: 1, output: 5 },
  'o3': { cacheRead: 0.5, input: 2, output: 8 },
  'o3-pro': { cacheRead: 20, input: 20, output: 80 }
};
const TOKENS_PER_UNIT = 1_000_000;

/**
 * Compute the estimated cost in US dollars of one Claude API response usage block.
 */

export function computeClaudeCost(model, usage) {
  const prices = model ? findClaudePrices(model) : null;

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

/**
 * Compute the estimated cost in US dollars of an OpenAI token usage, whose input tokens include the cached ones.
 */

export function computeOpenAiCost(model, usage) {
  const prices = model ? OPENAI_MODEL_PRICES[model] : null;

  if (!prices) {
    return 0;
  }

  const cachedInput = usage.cached_input_tokens ?? 0;
  const total =
    Math.max((usage.input_tokens ?? 0) - cachedInput, 0) * prices.input +
    cachedInput * prices.cacheRead +
    (usage.output_tokens ?? 0) * prices.output;

  return total / TOKENS_PER_UNIT;
}

/**
 * Find the prices of the given Claude model, ignoring context window suffixes such as "[1m]".
 */

function findClaudePrices(model) {
  return CLAUDE_MODEL_PRICES[model.replace(/\[.*\]$/, '')] ?? null;
}
