import { Hono } from 'hono';
import { z } from 'zod';
import { drizzle } from 'drizzle-orm/d1';
import { eq, desc, and, sql } from 'drizzle-orm';
import type { Env } from '../types/env.js';
import { trades, agents } from '../db/schema.js';
import { validateQuery } from '../lib/validation.js';

const tradesRoute = new Hono<{ Bindings: Env }>();

/** GET /api/trades — all trades across agents */
tradesRoute.get('/', async (c) => {
  const query = validateQuery(
    c,
    z.object({
      status: z.enum(['open', 'closed', 'stopped_out']).optional(),
      pair: z.string().optional(),
      limit: z.coerce.number().min(1).max(500).default(100),
    })
  );

  const db = drizzle(c.env.DB);

  let baseQuery = db.select().from(trades).$dynamic();

  if (query.status) {
    baseQuery = baseQuery.where(eq(trades.status, query.status));
  }

  const results = await baseQuery
    .orderBy(desc(trades.openedAt))
    .limit(query.limit);

  return c.json({ trades: results, count: results.length });
});

/** GET /api/trades/stats — aggregate stats */
tradesRoute.get('/stats', async (c) => {
  const db = drizzle(c.env.DB);

  const statsResult = await db
    .select({
      totalTrades: sql<number>`count(*)`,
      openTrades: sql<number>`sum(case when status = 'open' then 1 else 0 end)`,
      closedTrades: sql<number>`sum(case when status = 'closed' then 1 else 0 end)`,
      winningTrades: sql<number>`sum(case when pnl_pct > 0 then 1 else 0 end)`,
      totalPnlUsd: sql<number>`sum(coalesce(pnl_usd, 0))`,
      avgPnlPct: sql<number>`avg(pnl_pct)`,
    })
    .from(trades);

  const stats = statsResult[0];
  const winRate =
    stats.closedTrades > 0
      ? (stats.winningTrades / stats.closedTrades) * 100
      : 0;

  return c.json({
    totalTrades: stats.totalTrades ?? 0,
    openTrades: stats.openTrades ?? 0,
    closedTrades: stats.closedTrades ?? 0,
    winRate: Math.round(winRate * 10) / 10,
    totalPnlUsd: Math.round((stats.totalPnlUsd ?? 0) * 100) / 100,
    avgPnlPct: Math.round((stats.avgPnlPct ?? 0) * 100) / 100,
  });
});

// Error handler
tradesRoute.onError((err, c) => {
  console.error('[trades route]', err);
  return c.json({ error: 'Internal server error' }, 500);
});

export default tradesRoute;
