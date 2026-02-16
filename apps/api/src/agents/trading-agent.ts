import { DurableObject } from 'cloudflare:workers';
import { drizzle } from 'drizzle-orm/d1';
import type { Env } from '../types/env.js';
import { performanceSnapshots } from '../db/schema.js';
import { PaperEngine } from '../services/paper-engine.js';
import { runAgentLoop } from './agent-loop.js';
import { generateId, nowIso } from '../lib/utils.js';

/** Interval string → milliseconds */
function intervalToMs(interval: string): number {
  switch (interval) {
    case '1m':  return 60_000;
    case '5m':  return 5 * 60_000;
    case '15m': return 15 * 60_000;
    case '1h':  return 60 * 60_000;
    case '4h':  return 4 * 60 * 60_000;
    case '1d':  return 24 * 60 * 60_000;
    default:    return 60 * 60_000;
  }
}

/**
 * TradingAgentDO — Durable Object managing a single trading agent instance.
 *
 * Persistent state (via ctx.storage):
 * - agentId: string
 * - status: 'running' | 'stopped' | 'paused'
 * - engineState: serialized PaperEngine state
 * - lastStopOutAt: timestamp of last stop-out (for cooldown)
 *
 * The alarm fires on each analysis interval tick and runs the full agent loop.
 */
export class TradingAgentDO extends DurableObject<Env> {
  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/status') {
      const agentId = (await this.ctx.storage.get<string>('agentId')) ?? null;
      const status = (await this.ctx.storage.get<string>('status')) ?? 'stopped';
      const engineState = await this.ctx.storage.get<ReturnType<PaperEngine['serialize']>>('engineState');
      const balance = engineState?.balance ?? null;
      const nextAlarmAt = (await this.ctx.storage.get<number>('nextAlarmAt')) ?? null;
      return Response.json({ agentId, status, balance, nextAlarmAt });
    }

    if (url.pathname === '/start' && request.method === 'POST') {
      const body = (await request.json()) as {
        agentId: string;
        paperBalance?: number;
        slippageSimulation?: number;
        analysisInterval?: string;
      };

      const currentAgentId = await this.ctx.storage.get<string>('agentId');

      // Initialize engine only on first start (preserve state on restart)
      if (!currentAgentId || currentAgentId !== body.agentId) {
        const balance = body.paperBalance ?? 10_000;
        const slippage = body.slippageSimulation ?? 0.3;
        const engine = new PaperEngine({ balance, slippage });
        await this.ctx.storage.put('engineState', engine.serialize());
      }

      await this.ctx.storage.put('agentId', body.agentId);
      await this.ctx.storage.put('status', 'running');
      await this.ctx.storage.put('analysisInterval', body.analysisInterval ?? '1h');

      // Schedule first tick
      const intervalMs = intervalToMs(body.analysisInterval ?? '1h');
      const firstTick = Math.min(5_000, intervalMs); // first tick in 5s (for quick testing)
      const nextAlarmAt = Date.now() + firstTick;
      await this.ctx.storage.put('nextAlarmAt', nextAlarmAt);
      await this.ctx.storage.setAlarm(nextAlarmAt);

      return Response.json({ ok: true, status: 'running' });
    }

    if (url.pathname === '/analyze' && request.method === 'POST') {
      // Run one immediate analysis cycle regardless of status (for manual trigger / testing)
      const agentId = await this.ctx.storage.get<string>('agentId');
      if (!agentId) return Response.json({ error: 'Agent not initialized' }, { status: 400 });

      const engineState = await this.ctx.storage.get<ReturnType<PaperEngine['serialize']>>('engineState');
      const engine = engineState
        ? PaperEngine.deserialize(engineState)
        : new PaperEngine({ balance: 10_000, slippage: 0.3 });

      try {
        await runAgentLoop(agentId, engine, this.env, this.ctx);
      } catch (err) {
        console.error(`[TradingAgentDO] manual analyze error for ${agentId}:`, err);
        return Response.json({ error: String(err) }, { status: 500 });
      }

      await this.ctx.storage.put('engineState', engine.serialize());

      // If agent is running, reschedule the alarm from now (reset the timer)
      const status = (await this.ctx.storage.get<string>('status')) ?? 'stopped';
      if (status === 'running') {
        const interval = (await this.ctx.storage.get<string>('analysisInterval')) ?? '1h';
        const nextAlarmAt = Date.now() + intervalToMs(interval);
        await this.ctx.storage.put('nextAlarmAt', nextAlarmAt);
        await this.ctx.storage.setAlarm(nextAlarmAt);
      }

      return Response.json({ ok: true });
    }

    if (url.pathname === '/stop' && request.method === 'POST') {
      await this.ctx.storage.put('status', 'stopped');
      await this.ctx.storage.deleteAlarm();
      return Response.json({ ok: true, status: 'stopped' });
    }

    if (url.pathname === '/pause' && request.method === 'POST') {
      await this.ctx.storage.put('status', 'paused');
      await this.ctx.storage.deleteAlarm();
      return Response.json({ ok: true, status: 'paused' });
    }

    if (url.pathname === '/engine-state') {
      const engineState = await this.ctx.storage.get<ReturnType<PaperEngine['serialize']>>('engineState');
      return Response.json(engineState ?? null);
    }

    return new Response('Not Found', { status: 404 });
  }

  async alarm(): Promise<void> {
    const status = (await this.ctx.storage.get<string>('status')) ?? 'stopped';
    if (status !== 'running') return;

    const agentId = await this.ctx.storage.get<string>('agentId');
    if (!agentId) return;

    // Restore or init engine
    const engineState = await this.ctx.storage.get<ReturnType<PaperEngine['serialize']>>('engineState');
    const engine = engineState
      ? PaperEngine.deserialize(engineState)
      : new PaperEngine({ balance: 10_000, slippage: 0.3 });

    // Run the analysis loop
    try {
      await runAgentLoop(agentId, engine, this.env, this.ctx);
    } catch (err) {
      console.error(`[TradingAgentDO] alarm error for ${agentId}:`, err);
    }

    // Persist updated engine state
    await this.ctx.storage.put('engineState', engine.serialize());

    // Save a performance snapshot periodically (every ~6 ticks)
    const tickCount = ((await this.ctx.storage.get<number>('tickCount')) ?? 0) + 1;
    await this.ctx.storage.put('tickCount', tickCount);

    if (tickCount % 6 === 0) {
      await this.savePerformanceSnapshot(agentId, engine);
    }

    // Reschedule next alarm
    const interval = (await this.ctx.storage.get<string>('analysisInterval')) ?? '1h';
    const nextAlarmAt = Date.now() + intervalToMs(interval);
    await this.ctx.storage.put('nextAlarmAt', nextAlarmAt);
    await this.ctx.storage.setAlarm(nextAlarmAt);
  }

  private async savePerformanceSnapshot(
    agentId: string,
    engine: PaperEngine
  ): Promise<void> {
    try {
      const db = drizzle(this.env.DB);
      const closed = engine.closedPositions;
      const totalTrades = closed.length;
      const winRate = engine.getWinRate();
      const totalPnlPct = engine.getTotalPnlPct();

      // Simplified Sharpe (assume 0% risk-free, using stddev of pnl pcts)
      let sharpeRatio: number | null = null;
      if (closed.length >= 5) {
        const pnls = closed.map((t) => t.pnlPct ?? 0);
        const mean = pnls.reduce((a, b) => a + b, 0) / pnls.length;
        const variance =
          pnls.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / pnls.length;
        const stddev = Math.sqrt(variance);
        sharpeRatio = stddev > 0 ? mean / stddev : 0;
      }

      // Max drawdown from closed trades
      let maxDrawdown: number | null = null;
      if (closed.length >= 2) {
        let peak = 0;
        let drawdown = 0;
        let cumPnl = 0;
        for (const t of closed) {
          cumPnl += t.pnlPct ?? 0;
          if (cumPnl > peak) peak = cumPnl;
          const dd = peak - cumPnl;
          if (dd > drawdown) drawdown = dd;
        }
        maxDrawdown = drawdown;
      }

      await db.insert(performanceSnapshots).values({
        id: generateId('snap'),
        agentId,
        balance: engine.balance,
        totalPnlPct,
        winRate,
        totalTrades,
        sharpeRatio,
        maxDrawdown,
        snapshotAt: nowIso(),
      });
    } catch (err) {
      console.warn(`[TradingAgentDO] Failed to save snapshot:`, err);
    }
  }
}
