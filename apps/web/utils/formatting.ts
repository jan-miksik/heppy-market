export function formatRelativeTime(iso: string, nowMs = Date.now()): string {
  const ms = Math.max(0, nowMs - new Date(iso).getTime());
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

export function formatCompactPrice(price: number): string {
  if (!Number.isFinite(price) || price <= 0) return '0';
  if (price >= 1) {
    return price.toLocaleString('en', { maximumFractionDigits: 4 });
  }

  const magnitude = Math.floor(Math.log10(price));
  const maximumFractionDigits = Math.min(12, Math.max(4, 4 - magnitude));
  return price.toLocaleString('en', {
    maximumFractionDigits,
  });
}

export function remainingAnalyzeBannerDelayMs(
  startedAtMs: number,
  nowMs: number,
  delayMs: number,
): number {
  return Math.max(0, delayMs - (nowMs - startedAtMs));
}
