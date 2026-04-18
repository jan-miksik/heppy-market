function normalizeCacheSegment(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, '-');
}

export function geckoSearchKey(query: string, network = 'base'): string {
  return `gecko:search:${normalizeCacheSegment(network)}:${normalizeCacheSegment(query)}`;
}

export function geckoOhlcvKey(
  address: string,
  timeframe: 'hour' | 'day',
  limit: number,
  network = 'base',
): string {
  return `gecko:ohlcv:${normalizeCacheSegment(network)}:${address.trim().toLowerCase()}:${timeframe}:${limit}`;
}

export function dexSearchKey(query: string): string {
  return `dex:search:${normalizeCacheSegment(query)}`;
}

export function dexTokenPairsKey(address: string): string {
  return `dex:token-pairs:${address.trim().toLowerCase()}`;
}

export function dexPairKey(chain: string, pairAddress: string): string {
  return `dex:pair:${normalizeCacheSegment(chain)}:${pairAddress.trim().toLowerCase()}`;
}

export function dexTopPairsKey(chain: string): string {
  return `dex:top:${normalizeCacheSegment(chain)}`;
}
