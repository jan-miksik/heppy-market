/**
 * Performance snapshot service.
 * Called by the hourly Cron Trigger to compute and persist snapshots
 * for all running agents.
 */
import { drizzle } from 'drizzle-orm/d1';
import { eq, desc } from 'drizzle-orm';
import { agents, trades, performanceSnapshots } from '../db/schema.js';
import { generateId, nowIso } from '../lib/utils.js';
import type { Env } from '../types/env.js';

/** Compute performance metrics for a single agent from its trade records */
export interface AgentPerformanceMetrics {
  balance: number;
  totalPnlPct: number;
  winRate: number;
  totalTrades: number;
  sharpeRatio: number | null;
  maxDrawdown: number | null;
}

export function computeMetrics(
  closedTrades: Array<{ pnlPct: number | null; pnlUsd: number | null }>,
  initialBalance: number,
  currentBalance: number
): AgentPerformanceMetrics {
  const totalTrades = closedTrades.length;
  const wins = closedTrades.filter((t) => (t.pnlPct ?? 0) > 0).length;
  const winRate = totalTrades > 0 ? wins / totalTrades : 0;
  const totalPnlPct = ((currentBalance - initialBalance) / initialBalance) * 100;

  let sharpeRatio: number | null = null;
  if (totalTrades >= 5) {
    const pnls = closedTrades.map((t) => t.pnlPct ?? 0);
    const mean = pnls.reduce((a, b) => a + b, 0) / pnls.length;
    const variance =
      pnls.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / pnls.length;
    const stddev = Math.sqrt(variance);
    sharpeRatio = stddev > 0 ? mean / stddev : 0;
  }

  let maxDrawdown: number | null = null;
  if (totalTrades >= 2) {
    let peak = 0;
    let dd = 0;
    let cum = 0;
    for (const t of closedTrades) {
      cum += t.pnlPct ?? 0;
      if (cum > peak) peak = cum;
      const drawdown = peak - cum;
      if (drawdown > dd) dd = drawdown;
    }
    maxDrawdown = dd;
  }

  return { balance: currentBalance, totalPnlPct, winRate, totalTrades, sharpeRatio, maxDrawdown };
}

/**
 * Save performance snapshots for all agents.
 * Called from the hourly Cron Trigger.
 */
export async function snapshotAllAgents(env: Env): Promise<void> {
  const db = drizzle(env.DB);

  const allAgents = await db.select().from(agents);
  if (allAgents.length === 0) return;

  for (const agent of allAgents) {
    try {
      const config = JSON.parse(agent.config) as { paperBalance: number };
      const agentTrades = await db
        .select({
          pnlPct: trades.pnlPct,
          pnlUsd: trades.pnlUsd,
          status: trades.status,
        })
        .from(trades)
        .where(eq(trades.agentId, agent.id));

      const closed = agentTrades.filter(
        (t) => t.status === 'closed' || t.status === 'stopped_out'
      );
      const openPnl = agentTrades
        .filter((t) => t.status === 'open')
        .reduce((acc, t) => acc + (t.pnlUsd ?? 0), 0);

      // Approximate current balance from initial + closed P&L + open P&L
      const closedPnl = closed.reduce((acc, t) => acc + (t.pnlUsd ?? 0), 0);
      const currentBalance = config.paperBalance + closedPnl + openPnl;

      const metrics = computeMetrics(closed, config.paperBalance, currentBalance);

      await db.insert(performanceSnapshots).values({
        id: generateId('snap'),
        agentId: agent.id,
        balance: metrics.balance,
        totalPnlPct: metrics.totalPnlPct,
        winRate: metrics.winRate,
        totalTrades: metrics.totalTrades,
        sharpeRatio: metrics.sharpeRatio,
        maxDrawdown: metrics.maxDrawdown,
        snapshotAt: nowIso(),
      });
    } catch (err) {
      console.error(`[snapshot] Failed for agent ${agent.id}:`, err);
    }
  }

  console.log(`[snapshot] Saved snapshots for ${allAgents.length} agents`);
}
