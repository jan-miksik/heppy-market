import type { Env } from '../types/env.js';

const COINGECKO_BASE = 'https://api.coingecko.com/api/v3';
const CACHE_TTL_SECONDS = 60;
const FETCH_TIMEOUT_MS = 8_000;

const STABLE_QUOTES = new Set(['USD', 'USDC', 'USDBC', 'USDT', 'DAI']);
const SYMBOL_TO_COIN_ID: Record<string, string> = {
  INIT: 'initia',
  INITIA: 'initia',
};

function normalizeSymbol(symbol: string): string {
  return symbol.trim().toUpperCase();
}

function getCoinIdForSymbol(symbol: string): string | null {
  return SYMBOL_TO_COIN_ID[normalizeSymbol(symbol)] ?? null;
}

function isStableQuote(symbol: string): boolean {
  return STABLE_QUOTES.has(normalizeSymbol(symbol));
}

/**
 * For pair-style inputs, resolve a CoinGecko coin id when one side is a stable quote.
 * Example: INIT/USDC -> initia
 */
export function resolveCoinGeckoCoinIdForPair(pairName: string): string | null {
  const [leftRaw, rightRaw, ...rest] = pairName.split('/');
  if (rest.length > 0 || !leftRaw || !rightRaw) return null;
  const left = normalizeSymbol(leftRaw);
  const right = normalizeSymbol(rightRaw);

  if (isStableQuote(right)) return getCoinIdForSymbol(left);
  if (isStableQuote(left)) return getCoinIdForSymbol(right);
  return null;
}

/** Fetch spot USD price for a CoinGecko coin id. Returns 0 on failure. */
export async function fetchCoinGeckoSpotUsd(env: Env, coinId: string): Promise<number> {
  const cacheKey = `coingecko:spot:${coinId}:usd`;
  try {
    const cached = await env.CACHE.get(cacheKey, 'text');
    if (cached) {
      const parsed = Number.parseFloat(cached);
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
  } catch {
    // non-fatal
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(
        `${COINGECKO_BASE}/simple/price?ids=${encodeURIComponent(coinId)}&vs_currencies=usd`,
        { headers: { Accept: 'application/json' }, signal: controller.signal },
      );
    } finally {
      clearTimeout(timeoutId);
    }
    if (!response.ok) return 0;

    const json = (await response.json()) as Record<string, { usd?: unknown }>;
    const usdRaw = json?.[coinId]?.usd;
    const usd = typeof usdRaw === 'number' ? usdRaw : Number(usdRaw);
    if (!Number.isFinite(usd) || usd <= 0) return 0;

    try {
      await env.CACHE.put(cacheKey, String(usd), { expirationTtl: CACHE_TTL_SECONDS });
    } catch {
      // non-fatal
    }
    return usd;
  } catch {
    return 0;
  }
}

/** Resolve spot USD by pair (e.g. INIT/USDC). Returns 0 when unsupported or unavailable. */
export async function resolveCoinGeckoSpotUsdForPair(env: Env, pairName: string): Promise<number> {
  const coinId = resolveCoinGeckoCoinIdForPair(pairName);
  if (!coinId) return 0;
  return fetchCoinGeckoSpotUsd(env, coinId);
}

