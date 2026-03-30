const SECONDS_MAP: Record<string, string> = {
  '60': '1h', '300': '1h', '900': '1h', '3600': '1h', '14400': '4h', '86400': '1d',
};

/** Normalise legacy seconds-based interval strings to human-readable labels. */
export function formatInterval(interval: string): string {
  return SECONDS_MAP[interval] ?? interval;
}
