/**
 * Normalize trading pair names for GeckoTerminal/DexScreener (Base chain).
 * Maps CEX-style symbols (e.g. ETH-USD) to Dex format (WETH/USDC) so the
 * agent works when the manager or user supplies the wrong format.
 */
const CEX_TO_DEX_PAIRS: Record<string, string> = {
  'ETH-USD': 'WETH/USDC',
  'ETH/USD': 'WETH/USDC',
  'BTC-USD': 'cbBTC/USDC',
  'BTC/USD': 'cbBTC/USDC',
  'AERO-USD': 'AERO/USDC',
  'AERO/USD': 'AERO/USDC',
  'DEGEN-USD': 'DEGEN/USDC',
  'DEGEN/USD': 'DEGEN/USDC',
};

/**
 * Returns the Dex-style pair name (e.g. "WETH/USDC") for GeckoTerminal/DexScreener.
 * If the input already contains "/", it is returned trimmed. Otherwise CEX-style
 * names are mapped via CEX_TO_DEX_PAIRS.
 */
export function normalizePairForDex(pair: string): string {
  const trimmed = pair.trim();
  if (trimmed.includes('/')) return trimmed;
  const upper = trimmed.toUpperCase().replace(/\s+/g, '-');
  return CEX_TO_DEX_PAIRS[upper] ?? trimmed;
}

/**
 * Normalize an array of pair names (e.g. when saving agent config).
 */
export function normalizePairsForDex(pairs: string[]): string[] {
  return pairs.map(normalizePairForDex);
}
