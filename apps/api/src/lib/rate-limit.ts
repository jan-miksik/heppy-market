import type { Context, MiddlewareHandler } from 'hono';

/**
 * Simple fixed-window rate limiter backed by Cloudflare KV.
 * NOTE: Cloudflare KV operations are not atomic, so this provides
 *       best-effort limiting under concurrency, not a strict guarantee.
 */

export interface RateLimitConfig {
  /** Identifier for this limit (e.g. "api:global" or "agent:abc:llm") */
  key: string;
  /** Max requests allowed in the window */
  limit: number;
  /** Window duration in seconds */
  windowSecs: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number; // Unix timestamp
}

export type RateLimitStrategy = 'kv' | 'memory';

const MEMORY_MAX_ENTRIES = 10_000;
const memoryCounters = new Map<
  string,
  { count: number; resetAt: number; expiresAt: number }
>();
let memoryLastCleanupSec = 0;

function cleanupMemory(nowSec: number): void {
  // Amortize cleanup to avoid doing O(n) work on every request.
  if (nowSec - memoryLastCleanupSec < 30) return;
  memoryLastCleanupSec = nowSec;

  for (const [k, v] of memoryCounters) {
    if (v.expiresAt <= nowSec) memoryCounters.delete(k);
  }

  // Hard cap to avoid unbounded growth under high-cardinality keys.
  if (memoryCounters.size > MEMORY_MAX_ENTRIES) {
    let toDelete = memoryCounters.size - MEMORY_MAX_ENTRIES;
    for (const k of memoryCounters.keys()) {
      memoryCounters.delete(k);
      toDelete--;
      if (toDelete <= 0) break;
    }
  }
}

/**
 * Check and increment a rate limit counter in KV.
 * Returns whether the request is allowed and how many remain.
 */
export async function checkRateLimit(
  cache: KVNamespace,
  config: RateLimitConfig
): Promise<RateLimitResult> {
  const nowSec = Math.floor(Date.now() / 1000);
  const windowKey = `rl:${config.key}:${Math.floor(nowSec / config.windowSecs)}`;

  const rawCount = await cache.get(windowKey, 'text');
  const count = rawCount ? parseInt(rawCount, 10) : 0;

  const resetAt = (Math.floor(nowSec / config.windowSecs) + 1) * config.windowSecs;
  const remaining = Math.max(0, config.limit - count - 1);

  if (count >= config.limit) {
    return { allowed: false, remaining: 0, resetAt };
  }

  await cache.put(windowKey, String(count + 1), {
    expirationTtl: config.windowSecs * 2,
  });

  return { allowed: true, remaining, resetAt };
}

/**
 * In-memory (per-isolate) fixed-window rate limiter.
 *
 * Pros: zero KV ops (avoids KV free-tier burn), very fast.
 * Cons: not global/distributed; resets on isolate eviction.
 */
export async function checkRateLimitMemory(
  config: RateLimitConfig
): Promise<RateLimitResult> {
  const nowSec = Math.floor(Date.now() / 1000);
  cleanupMemory(nowSec);

  const windowIndex = Math.floor(nowSec / config.windowSecs);
  const windowKey = `rl:${config.key}:${windowIndex}`;

  const resetAt = (windowIndex + 1) * config.windowSecs;
  const expiresAt = resetAt + config.windowSecs; // keep for 2 windows to tolerate skew

  const existing = memoryCounters.get(windowKey);
  const count = existing?.count ?? 0;

  const remaining = Math.max(0, config.limit - count - 1);
  if (count >= config.limit) {
    return { allowed: false, remaining: 0, resetAt };
  }

  memoryCounters.set(windowKey, { count: count + 1, resetAt, expiresAt });
  return { allowed: true, remaining, resetAt };
}

/**
 * Rate limit middleware for Hono routes.
 * Returns a 429 response if the limit is exceeded.
 */
export function createRateLimitMiddleware<E extends { Bindings: { CACHE: KVNamespace } }>(
  config: Omit<RateLimitConfig, 'key'> & { strategy?: RateLimitStrategy }
): MiddlewareHandler<E> {
  return (async (c: Context<E>, next) => {
    // Derive a best-effort client identifier:
    // - Prefer Cloudflare's CF-Connecting-IP header in production (not user-controllable)
    // - Fall back to X-Forwarded-For for local/dev proxies
    const forwardedFor = c.req.header('X-Forwarded-For');
    const firstForwarded = forwardedFor?.split(',')[0]?.trim();
    const ip = c.req.header('CF-Connecting-IP') ?? firstForwarded ?? 'global';

    const strategy: RateLimitStrategy = config.strategy ?? 'kv';
    const cfg: RateLimitConfig = { ...config, key: `ip:${ip}` };
    const result =
      strategy === 'memory'
        ? await checkRateLimitMemory(cfg)
        : await checkRateLimit(c.env.CACHE, cfg);

    const retryAfterSecs = Math.max(0, result.resetAt - Math.floor(Date.now() / 1000));

    if (!result.allowed) {
      return Response.json(
        { error: 'Rate limit exceeded', retryAfter: retryAfterSecs },
        {
          status: 429,
          headers: {
            'Retry-After': String(retryAfterSecs),
            'X-RateLimit-Limit': String(config.limit),
            'X-RateLimit-Remaining': '0',
            'X-RateLimit-Reset': String(result.resetAt),
          },
        }
      );
    }

    // Add rate limit headers
    c.header('X-RateLimit-Limit', String(config.limit));
    c.header('X-RateLimit-Remaining', String(result.remaining));
    c.header('X-RateLimit-Reset', String(result.resetAt));

    return next();
  }) as MiddlewareHandler<E>;
}
