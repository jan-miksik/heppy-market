/**
 * Generate a URL-safe unique ID using the Web Crypto API.
 * Works in Cloudflare Workers (no Node.js crypto needed).
 */
export function generateId(prefix?: string): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return prefix ? `${prefix}_${hex}` : hex;
}

/** Get current UTC ISO timestamp */
export function nowIso(): string {
  return new Date().toISOString();
}

/** Clamp a number between min and max */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** Sleep for ms milliseconds */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Exponential backoff retry */
export async function retry<T>(
  fn: () => Promise<T>,
  maxAttempts: number = 3,
  baseDelayMs: number = 1000
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt < maxAttempts - 1) {
        await sleep(baseDelayMs * Math.pow(2, attempt));
      }
    }
  }
  throw lastError;
}

/** Autonomy level string to numeric */
export function autonomyLevelToInt(level: string): number {
  switch (level) {
    case 'full':
      return 1;
    case 'guided':
      return 2;
    case 'strict':
      return 3;
    default:
      return 2;
  }
}

/** Numeric autonomy level to string */
export function intToAutonomyLevel(level: number): string {
  switch (level) {
    case 1:
      return 'full';
    case 2:
      return 'guided';
    case 3:
      return 'strict';
    default:
      return 'guided';
  }
}
