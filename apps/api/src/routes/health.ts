import { Hono } from 'hono';
import type { Env } from '../types/env.js';
import type { AuthVariables } from '../lib/auth.js';
import { parseCookieValue, getSession } from '../lib/auth.js';
import { drizzle } from 'drizzle-orm/d1';
import { eq } from 'drizzle-orm';
import { users } from '../db/schema.js';

/**
 * Cache key prefixes used by market data services.
 * These map 1:1 to the prefixes in gecko-terminal.ts and dex-data.ts.
 */
export const CACHE_PREFIXES = ['gecko:', 'dex:', 'cron:', 'rl:'];

const health = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

health.get('/', async (c) => {
  // Verify D1 is accessible
  let dbStatus = 'ok';
  try {
    await c.env.DB.prepare('SELECT 1').run();
  } catch (err) {
    dbStatus = `error: ${String(err)}`;
  }

  return c.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: '0.1.0',
    services: {
      db: dbStatus,
      cache: 'ok',
    },
  });
});

/**
 * POST /api/health/cache/purge — delete KV cache entries by prefix.
 * Gated to tester role. Accepts optional `prefix` query param (default: all market data prefixes).
 *
 * Query params:
 *   prefix — one of: gecko, dex, cron, rl (default: purges gecko + dex)
 *
 * Returns the number of keys deleted.
 */
health.post('/cache/purge', async (c) => {
  // Auth: require session + tester role
  const cookieHeader = c.req.header('cookie') ?? '';
  const token = parseCookieValue(cookieHeader, 'session');
  if (!token) return c.json({ error: 'Unauthorized' }, 401);

  const session = await getSession(c.env.CACHE, token, c.env.DB);
  if (!session) return c.json({ error: 'Unauthorized' }, 401);

  const db = drizzle(c.env.DB);
  const [user] = await db.select({ role: users.role }).from(users).where(eq(users.id, session.userId));
  if (user?.role !== 'tester') return c.json({ error: 'Forbidden — tester role required' }, 403);

  const requestedPrefix = c.req.query('prefix');
  const prefixesToPurge = requestedPrefix
    ? CACHE_PREFIXES.filter((p) => p.startsWith(requestedPrefix))
    : ['gecko:', 'dex:'];

  if (prefixesToPurge.length === 0) {
    return c.json({ error: `Unknown prefix "${requestedPrefix}". Valid: ${CACHE_PREFIXES.join(', ')}` }, 400);
  }

  let deleted = 0;
  for (const prefix of prefixesToPurge) {
    let cursor: string | undefined;
    do {
      const listed: KVNamespaceListResult<unknown, string> = await c.env.CACHE.list({ prefix, limit: 1000, cursor });
      for (const key of listed.keys) {
        await c.env.CACHE.delete(key.name);
        deleted++;
      }
      cursor = listed.list_complete ? undefined : listed.cursor;
    } while (cursor);
  }

  console.log(`[cache/purge] deleted ${deleted} keys for prefixes: ${prefixesToPurge.join(', ')}`);
  return c.json({ ok: true, deleted, prefixes: prefixesToPurge });
});

export default health;
