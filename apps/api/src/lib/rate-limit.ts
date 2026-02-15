/**
 * Simple rate limiter backed by Cloudflare KV.
 * Uses a sliding window (token-bucket approximation) stored as a JSON counter.
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
 * Rate limit middleware for Hono routes.
 * Returns a 429 response if the limit is exceeded.
 */
export function createRateLimitMiddleware(config: Omit<RateLimitConfig, 'key'>) {
  return async (c: { env: { CACHE: KVNamespace }; req: { header: (h: string) => string | undefined } }, next: () => Promise<void>) => {
    // Use IP or a global key
    const ip = c.req.header('CF-Connecting-IP') ?? 'global';
    const result = await checkRateLimit(c.env.CACHE, {
      ...config,
      key: `ip:${ip}`,
    });

    if (!result.allowed) {
      return Response.json(
        { error: 'Rate limit exceeded', retryAfter: result.resetAt - Math.floor(Date.now() / 1000) },
        {
          status: 429,
          headers: {
            'Retry-After': String(result.resetAt - Math.floor(Date.now() / 1000)),
            'X-RateLimit-Limit': String(config.limit),
            'X-RateLimit-Remaining': '0',
            'X-RateLimit-Reset': String(result.resetAt),
          },
        }
      );
    }

    // Add rate limit headers
    (c as any).header?.('X-RateLimit-Remaining', String(result.remaining));
    (c as any).header?.('X-RateLimit-Reset', String(result.resetAt));

    await next();
  };
}
