/**
 * Static allowlist of supported trading pairs for Base chain.
 *
 * For now this is intentionally conservative: only include pairs we know our
 * market-data providers can resolve reliably. We can make this dynamic later.
 */
export const SUPPORTED_BASE_PAIRS = [
  'WETH/USDC',
  'WETH/USDbC',
  'cbBTC/USDC',
  'cbBTC/WETH',
  'AERO/USDC',
  'DEGEN/USDC',
  'BRETT/USDC',
  'TOSHI/USDC',
] as const;

export type SupportedBasePair = (typeof SUPPORTED_BASE_PAIRS)[number];

export const SUPPORTED_BASE_PAIRS_SET: ReadonlySet<string> = new Set(SUPPORTED_BASE_PAIRS);

/** Keep order, de-dupe, and filter to the supported allowlist. */
export function filterSupportedBasePairs(pairs: string[]): string[] {
  const out: string[] = [];
  for (const p of pairs) {
    if (!SUPPORTED_BASE_PAIRS_SET.has(p)) continue;
    if (out.includes(p)) continue;
    out.push(p);
  }
  return out;
}

