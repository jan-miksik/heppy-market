import { drizzle } from 'drizzle-orm/d1';
import { eq } from 'drizzle-orm';
import { AgentConfigSchema } from '@something-in-loop/shared';
import { agents } from '../../db/schema.js';
import { nowIso } from '../../lib/utils.js';
import { resolveCurrentPriceUsd } from '../../services/price-resolver.js';
import { PaperEngine } from '../../services/paper-engine.js';
import type { Env } from '../../types/env.js';
import type { CachedAgentRow } from '../trading-agent.js';
import { persistTrade } from './execution.js';

type RunRiskControlsParams = {
  agentId: string;
  engine: PaperEngine;
  env: Env;
  db: ReturnType<typeof drizzle>;
  ctx: DurableObjectState;
  config: ReturnType<typeof AgentConfigSchema.parse>;
};

/**
 * Applies guardrails before LLM analysis:
 * - daily loss stop
 * - cooldown after stop-out
 * - per-position SL/TP checks
 *
 * Returns false when tick processing should stop.
 */
export async function runRiskControls(params: RunRiskControlsParams): Promise<boolean> {
  const { agentId, engine, env, db, ctx, config } = params;
  engine.resetDailyTrackingIfNeeded();
  const dailyPnl = engine.getDailyPnlPct();
  if (dailyPnl <= -config.maxDailyLossPct) {
    console.log(`[agent-loop] ${agentId}: Daily loss limit reached (${dailyPnl.toFixed(2)}%), pausing`);
    await db.update(agents).set({ status: 'paused', updatedAt: nowIso() }).where(eq(agents.id, agentId));
    try {
      await ctx.storage.put('status', 'paused');
      const cached = await ctx.storage.get<CachedAgentRow>('cachedAgentRow');
      if (cached) await ctx.storage.put('cachedAgentRow', { ...cached, status: 'paused' });
    } catch {
      // non-fatal
    }
    return false;
  }

  if (config.cooldownAfterLossMinutes > 0) {
    const cooldownMs = config.cooldownAfterLossMinutes * 60_000;
    const lastStopOut = await ctx.storage.get<number>('lastStopOutAt');
    if (lastStopOut && Date.now() - lastStopOut < cooldownMs) {
      console.log(`[agent-loop] ${agentId}: In cooldown, skipping tick`);
      return false;
    }
  }

  for (const position of engine.openPositions) {
    const currentPrice = await resolveCurrentPriceUsd(env, position.pair);
    if (currentPrice === 0) {
      const missKey = `priceMiss:${position.id}`;
      const misses = ((await ctx.storage.get<number>(missKey)) ?? 0) + 1;
      await ctx.storage.put(missKey, misses);
      if (misses >= 3) {
        console.error(
          `[agent-loop] ${agentId}: CRITICAL - price resolution failed ${misses} consecutive times for open position ${position.id} (${position.pair}). SL/TP checks skipped. Investigate GeckoTerminal/DexScreener availability.`,
        );
      } else {
        console.warn(
          `[agent-loop] ${agentId}: Price resolution returned 0 for ${position.pair} (miss #${misses}). Skipping SL/TP check this tick.`,
        );
      }
      continue;
    }
    await ctx.storage.delete(`priceMiss:${position.id}`);

    if (engine.checkStopLoss(position, currentPrice, config.stopLossPct)) {
      try {
        const closed = engine.stopOutPosition(position.id, currentPrice);
        await ctx.storage.put('pendingTrade', closed);
        await persistTrade(db, closed);
        await ctx.storage.delete('pendingTrade');
        await ctx.storage.delete(`priceMiss:${position.id}`);
        await ctx.storage.put('lastStopOutAt', Date.now());
        console.log(`[agent-loop] ${agentId}: Stop loss triggered for ${position.pair} at $${currentPrice}`);
      } catch (err) {
        console.warn(`[agent-loop] ${agentId}: Failed to persist stop-loss for ${position.pair}:`, err);
      }
      continue;
    }

    if (engine.checkTakeProfit(position, currentPrice, config.takeProfitPct)) {
      try {
        const closed = engine.closePosition(position.id, {
          price: currentPrice,
          reason: 'Take profit triggered',
          closeReason: 'take_profit',
        });
        await ctx.storage.put('pendingTrade', closed);
        await persistTrade(db, closed);
        await ctx.storage.delete('pendingTrade');
        await ctx.storage.delete(`priceMiss:${position.id}`);
        console.log(`[agent-loop] ${agentId}: Take profit triggered for ${position.pair} at $${currentPrice}`);
      } catch (err) {
        console.warn(`[agent-loop] ${agentId}: Failed to persist take-profit for ${position.pair}:`, err);
      }
    }
  }

  return true;
}
