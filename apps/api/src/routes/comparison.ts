import { Hono } from 'hono';
import { drizzle } from 'drizzle-orm/d1';
import { eq, desc, inArray } from 'drizzle-orm';
import type { Env } from '../types/env.js';
import { agents, trades, performanceSnapshots } from '../db/schema.js';
import { intToAutonomyLevel } from '../lib/utils.js';

const comparison = new Hono<{ Bindings: Env }>();

/**
 * GET /api/compare?ids=id1,id2,id3
 * Returns side-by-side performance metrics for multiple agents.
 */
comparison.get('/', async (c) => {
  const idsParam = c.req.query('ids');
  if (!idsParam) {
    return c.json({ error: 'Provide agent IDs as ?ids=id1,id2,id3' }, 400);
  }

  const ids = idsParam
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .slice(0, 10); // max 10 agents

  if (ids.length === 0) return c.json({ error: 'No valid IDs provided' }, 400);

  const db = drizzle(c.env.DB);
  const agentRows = await db
    .select()
    .from(agents)
    .where(inArray(agents.id, ids));

  const results = await Promise.all(
    agentRows.map(async (agent) => {
      const config = JSON.parse(agent.config) as {
        paperBalance: number;
        pairs: string[];
        strategies: string[];
        analysisInterval: string;
      };

      const [snapshot] = await db
        .select()
        .from(performanceSnapshots)
        .where(eq(performanceSnapshots.agentId, agent.id))
        .orderBy(desc(performanceSnapshots.snapshotAt))
        .limit(1);

      const agentTrades = await db
        .select({
          status: trades.status,
          pnlPct: trades.pnlPct,
          pnlUsd: trades.pnlUsd,
        })
        .from(trades)
        .where(eq(trades.agentId, agent.id));

      const closed = agentTrades.filter(
        (t) => t.status === 'closed' || t.status === 'stopped_out'
      );
      const open = agentTrades.filter((t) => t.status === 'open');

      const wins = closed.filter((t) => (t.pnlPct ?? 0) > 0).length;
      const winRate = closed.length > 0 ? (wins / closed.length) * 100 : 0;
      const totalPnlUsd = closed.reduce((a, t) => a + (t.pnlUsd ?? 0), 0);
      const totalPnlPct =
        ((config.paperBalance + totalPnlUsd - config.paperBalance) /
          config.paperBalance) *
        100;

      return {
        id: agent.id,
        name: agent.name,
        status: agent.status,
        autonomyLevel: intToAutonomyLevel(agent.autonomyLevel),
        llmModel: agent.llmModel,
        config: {
          pairs: config.pairs,
          strategies: config.strategies,
          analysisInterval: config.analysisInterval,
          paperBalance: config.paperBalance,
        },
        metrics: {
          balance: snapshot?.balance ?? config.paperBalance,
          totalPnlPct: snapshot?.totalPnlPct ?? totalPnlPct,
          totalPnlUsd,
          winRate: snapshot?.winRate !== undefined ? snapshot.winRate * 100 : winRate,
          totalTrades: closed.length,
          openTrades: open.length,
          sharpeRatio: snapshot?.sharpeRatio ?? null,
          maxDrawdown: snapshot?.maxDrawdown ?? null,
        },
        createdAt: agent.createdAt,
      };
    })
  );

  // Sort by total P&L descending (best performer first)
  results.sort((a, b) => b.metrics.totalPnlPct - a.metrics.totalPnlPct);

  return c.json({ count: results.length, agents: results });
});

export default comparison;
