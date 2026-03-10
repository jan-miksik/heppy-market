import { Hono } from 'hono';
import { z } from 'zod';
import { drizzle } from 'drizzle-orm/d1';
import { eq, desc, sql, inArray } from 'drizzle-orm';
import type { Env } from '../types/env.js';
import type { AuthVariables } from '../lib/auth.js';
import { agents, trades } from '../db/schema.js';
import { validateQuery } from '../lib/validation.js';

const tradesRoute = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

/** Shared ownership check: owns or legacy unowned */
async function requireAgentOwnership(
  db: ReturnType<typeof drizzle>,
  agentId: string,
  walletAddress: string
): Promise<typeof agents.$inferSelect | null> {
  const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
  if (!agent) return null;
  if (agent.ownerAddress && agent.ownerAddress !== walletAddress) return null;
  return agent;
}

/** GET /api/trades — trades scoped to the authenticated user's agents */
tradesRoute.get('/', async (c) => {
  const query = validateQuery(
    c,
    z.object({
      status: z.enum(['open', 'closed', 'stopped_out']).optional(),
      pair: z.string().optional(),
      limit: z.coerce.number().min(1).max(500).default(100),
    })
  );

  const walletAddress = c.get('walletAddress');
  const db = drizzle(c.env.DB);

  // Look up the caller's agents and scope trades to those IDs to avoid
  // leaking other users' trade history in multi-tenant deployments.
  const ownedAgents = await db
    .select({ id: agents.id })
    .from(agents)
    .where(eq(agents.ownerAddress, walletAddress));

  if (ownedAgents.length === 0) {
    return c.json({ trades: [], count: 0 });
  }

  const agentIds = ownedAgents.map((a) => a.id);

  let baseQuery = db
    .select()
    .from(trades)
    .where(inArray(trades.agentId, agentIds))
    .$dynamic();

  if (query.status) {
    baseQuery = baseQuery.where(eq(trades.status, query.status));
  }

  const results = await baseQuery
    .orderBy(desc(trades.openedAt))
    .limit(query.limit);

  return c.json({ trades: results, count: results.length });
});

/** POST /api/trades/:id/close — manually close an open trade */
tradesRoute.post('/:id/close', async (c) => {
  const id = c.req.param('id');
  const walletAddress = c.get('walletAddress');
  const db = drizzle(c.env.DB);

  const [trade] = await db.select().from(trades).where(eq(trades.id, id));
  if (!trade) return c.json({ error: 'Trade not found' }, 404);
  if (trade.status !== 'open') return c.json({ error: 'Trade is not open' }, 400);

  const agent = await requireAgentOwnership(db, trade.agentId, walletAddress);
  if (!agent) return c.json({ error: 'Trade not found' }, 404);

  const doId = c.env.TRADING_AGENT.idFromName(trade.agentId);
  const stub = c.env.TRADING_AGENT.get(doId);
  const res = await stub.fetch(
    new Request('http://do/close-position', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ positionId: id, reason: 'Closed manually by user' }),
    })
  );

  if (!res.ok) {
    const body = await res
      .json<{ error?: string }>()
      .catch(() => ({} as { error?: string }));
    return c.json({ error: body.error ?? 'Failed to close trade' }, 502);
  }

  const [updated] = await db.select().from(trades).where(eq(trades.id, id));
  return c.json({ ok: true, trade: updated });
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
