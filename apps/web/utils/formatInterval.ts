const SECONDS_MAP: Record<string, string> = {
  '60': '1m', '300': '5m', '900': '15m', '3600': '1h', '14400': '4h', '86400': '1d',
};

/** Normalise legacy seconds-based interval strings to human-readable labels. */
export function formatInterval(interval: string): string {
  return SECONDS_MAP[interval] ?? interval;
}
