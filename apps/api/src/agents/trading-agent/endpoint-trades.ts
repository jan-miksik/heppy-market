import { drizzle } from 'drizzle-orm/d1';
import { executeTradeDecision, type PendingLlmContext, type RecentDecision } from '../agent-loop.js';
import { persistTrade } from './persistence.js';
import { resolveCurrentPriceUsd } from '../../services/price-resolver.js';
import { loadEngine, persistEngineState } from './state.js';
import type { TradingAgentRuntime } from './types.js';

export async function handleClosePosition(runtime: TradingAgentRuntime, request: Request): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as { positionId?: string; reason?: string };
  const positionId = typeof body.positionId === 'string' ? body.positionId : '';
  if (!positionId) return Response.json({ error: 'positionId is required' }, { status: 400 });

  const agentId = await runtime.ctx.storage.get<string>('agentId');
  if (!agentId) return Response.json({ error: 'Agent not initialized' }, { status: 400 });

  const engine = await loadEngine(runtime.ctx.storage);
  const position = engine.openPositions.find((p) => p.id === positionId);
  if (!position) return Response.json({ error: 'Position not found' }, { status: 404 });

  const priceUsd = await resolveCurrentPriceUsd(runtime.env, position.pair);
  if (!priceUsd || priceUsd <= 0) {
    return Response.json({ error: 'Unable to resolve current price' }, { status: 503 });
  }

  const closed = engine.closePosition(positionId, {
    price: priceUsd,
    reason: body.reason ?? 'Closed manually by user',
    closeReason: 'manual',
  });

  try {
    await runtime.ctx.storage.put('pendingTrade', closed);
    await persistTrade(runtime.env, closed);
    await runtime.ctx.storage.delete('pendingTrade');
    await runtime.ctx.storage.delete(`priceMiss:${positionId}`);
  } catch (err) {
    console.error(`[TradingAgentDO] failed to persist manual close trade ${positionId}:`, err);
  }

  await persistEngineState(runtime.ctx.storage, engine, `failed to persist engine state after manual close for ${agentId}`);
  return Response.json({ ok: true, trade: closed });
}

export async function handleReceiveDecision(runtime: TradingAgentRuntime, request: Request): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as { jobId?: string; decision?: unknown };
  if (!body.jobId || !body.decision) {
    return Response.json({ error: 'jobId and decision are required' }, { status: 400 });
  }

  const pendingJobId = await runtime.ctx.storage.get<string>('pendingLlmJobId');
  if (pendingJobId !== body.jobId) {
    console.warn(`[TradingAgentDO] /receive-decision: stale jobId=${body.jobId} (pending=${pendingJobId})`);
    return Response.json({ ok: true, skipped: true });
  }

  const pendingCtx = await runtime.ctx.storage.get<PendingLlmContext>('pendingLlmContext');
  if (!pendingCtx) {
    await runtime.ctx.storage.delete('pendingLlmJobId');
    await runtime.ctx.storage.delete('pendingLlmJobAt');
    return Response.json({ error: 'Pending context expired' }, { status: 410 });
  }

  const agentId = await runtime.ctx.storage.get<string>('agentId');
  if (!agentId) return Response.json({ error: 'Agent not initialized' }, { status: 400 });

  const engine = await loadEngine(runtime.ctx.storage);
  const recentDecisions = (await runtime.ctx.storage.get<RecentDecision[]>('recentDecisions')) ?? [];

  const db = drizzle(runtime.env.DB);
  const { createLogger } = await import('../../lib/logger.js');
  const log = createLogger('agent-loop', agentId);

  try {
    await executeTradeDecision(body.decision as Parameters<typeof executeTradeDecision>[0], {
      agentId,
      engine,
      marketData: pendingCtx.marketData,
      pairsToFetch: pendingCtx.pairsToFetch,
      recentDecisions,
      effectiveLlmModel: pendingCtx.effectiveLlmModel,
      minConfidence: pendingCtx.minConfidence,
      maxOpenPositions: pendingCtx.maxOpenPositions,
      maxPositionSizePct: pendingCtx.maxPositionSizePct,
      dexes: pendingCtx.dexes,
      strategies: pendingCtx.strategies,
      slippageSimulation: pendingCtx.slippageSimulation,
      env: runtime.env,
      db,
      ctx: runtime.ctx,
      log,
    });
  } catch (err) {
    console.error(`[TradingAgentDO] /receive-decision execution error for ${agentId}:`, err);
    await runtime.ctx.storage.delete('pendingLlmJobId');
    await runtime.ctx.storage.delete('pendingLlmJobAt');
    await runtime.ctx.storage.delete('pendingLlmContext');
    return Response.json({ error: String(err) }, { status: 500 });
  }

  await persistEngineState(runtime.ctx.storage, engine, `failed to persist engine after /receive-decision for ${agentId}`);
  await runtime.ctx.storage.delete('pendingLlmJobId');
  await runtime.ctx.storage.delete('pendingLlmJobAt');
  await runtime.ctx.storage.delete('pendingLlmContext');

  return Response.json({ ok: true });
}
