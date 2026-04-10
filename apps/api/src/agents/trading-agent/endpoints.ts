import { drizzle } from 'drizzle-orm/d1';
import { intervalToMs, normalizeTradingInterval } from '@something-in-loop/shared';
import { executeTradeDecision, runAgentLoop, type PendingLlmContext, type RecentDecision } from '../agent-loop.js';
import { persistTrade } from './persistence.js';
import { resolveCurrentPriceUsd } from '../../services/price-resolver.js';
import { clearPriceMisses, syncCachedAgentRow, updateCachedAgentStatus } from './cache.js';
import {
  DEFAULT_BALANCE,
  DEFAULT_SLIPPAGE,
  LOOP_LOCK_TTL_MS,
  createPaperEngine,
  loadEngine,
  persistEngineState,
} from './state.js';
import { handleWebSocketUpgrade } from './websocket.js';
import type { CachedAgentRow, TradingAgentRuntime } from './types.js';

export async function handleTradingAgentRequest(
  runtime: TradingAgentRuntime,
  request: Request,
): Promise<Response | null> {
  const url = new URL(request.url);

  if (url.pathname === '/status') return handleStatus(runtime);
  if (url.pathname === '/start' && request.method === 'POST') return handleStart(runtime, request);
  if (url.pathname === '/analyze' && request.method === 'POST') return handleAnalyze(runtime, request);
  if (url.pathname === '/set-interval' && request.method === 'POST') return handleSetInterval(runtime, request);
  if (url.pathname === '/clear-history' && request.method === 'POST') return handleClearHistory(runtime, request);
  if (url.pathname === '/reset' && request.method === 'POST') return handleReset(runtime, request);
  if (url.pathname === '/stop' && request.method === 'POST') return handleSetStatus(runtime, 'stopped');
  if (url.pathname === '/pause' && request.method === 'POST') return handleSetStatus(runtime, 'paused');
  if (url.pathname === '/close-position' && request.method === 'POST') return handleClosePosition(runtime, request);
  if (url.pathname === '/engine-state') return handleEngineState(runtime);
  if (url.pathname === '/debug') return handleDebug(runtime);
  if (url.pathname === '/receive-decision' && request.method === 'POST') return handleReceiveDecision(runtime, request);
  if (url.pathname === '/sync-config' && request.method === 'POST') return handleSyncConfig(runtime, request);
  if (url.pathname === '/ws' && request.headers.get('Upgrade') === 'websocket') return handleWebSocketUpgrade(runtime);

  return null;
}

async function handleStatus(runtime: TradingAgentRuntime): Promise<Response> {
  const agentId = (await runtime.ctx.storage.get<string>('agentId')) ?? null;
  const status = (await runtime.ctx.storage.get<string>('status')) ?? 'stopped';
  const engineState = await runtime.ctx.storage.get<{ balance?: number }>('engineState');
  const balance = engineState?.balance ?? null;
  let nextAlarmAt = (await runtime.ctx.storage.get<number>('nextAlarmAt')) ?? null;
  const loopRunningAt = (await runtime.ctx.storage.get<number>('isLoopRunning')) ?? null;
  const pendingLlmJobId = (await runtime.ctx.storage.get<string>('pendingLlmJobId')) ?? null;
  const pendingLlmJobAt = (await runtime.ctx.storage.get<number>('pendingLlmJobAt')) ?? null;
  const pendingLlmAgeMs = pendingLlmJobAt ? Math.max(0, Date.now() - pendingLlmJobAt) : null;

  const analysisState: 'idle' | 'running' | 'awaiting_llm' =
    loopRunningAt ? 'running' : pendingLlmJobId ? 'awaiting_llm' : 'idle';

  if (status === 'running' && nextAlarmAt !== null && nextAlarmAt < Date.now() - 10_000) {
    const healed = Date.now() + 5_000;
    await runtime.ctx.storage.put('nextAlarmAt', healed);
    await runtime.ctx.storage.setAlarm(healed);
    nextAlarmAt = healed;
    console.log(`[TradingAgentDO] ${agentId}: alarm was overdue - rescheduled in 5s`);
  }

  return Response.json({
    agentId,
    status,
    balance,
    nextAlarmAt,
    analysisState,
    isLoopRunning: !!loopRunningAt,
    loopRunningAt,
    pendingLlmJobId,
    pendingLlmJobAt,
    pendingLlmAgeMs,
  });
}

async function handleStart(runtime: TradingAgentRuntime, request: Request): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as {
    agentId: string;
    paperBalance?: number;
    slippageSimulation?: number;
    analysisInterval?: string;
    agentRow?: CachedAgentRow;
  };
  if (typeof body.agentId !== 'string' || body.agentId.trim().length === 0) {
    return Response.json({ error: 'agentId is required' }, { status: 400 });
  }

  const safeAgentId = body.agentId.trim();
  const currentAgentId = await runtime.ctx.storage.get<string>('agentId');

  if (!currentAgentId || currentAgentId !== safeAgentId) {
    const engine = createPaperEngine({
      balance: body.paperBalance,
      slippage: body.slippageSimulation,
    });
    await runtime.ctx.storage.put('engineState', engine.serialize());
  }

  await runtime.ctx.storage.put('agentId', safeAgentId);
  await runtime.ctx.storage.put('status', 'running');
  const analysisInterval = normalizeTradingInterval(body.analysisInterval ?? '1h');
  await runtime.ctx.storage.put('analysisInterval', analysisInterval);

  if (body.agentRow) {
    await syncCachedAgentRow(runtime.ctx.storage, body.agentRow, 'running');
  }

  const intervalMs = intervalToMs(analysisInterval);
  const firstTick = Math.min(5_000, intervalMs);
  const nextAlarmAt = Date.now() + firstTick;
  await runtime.ctx.storage.put('nextAlarmAt', nextAlarmAt);
  await runtime.ctx.storage.setAlarm(nextAlarmAt);

  return Response.json({ ok: true, status: 'running' });
}

async function handleAnalyze(runtime: TradingAgentRuntime, request: Request): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as {
    agentId?: string;
    paperBalance?: number;
    slippageSimulation?: number;
    analysisInterval?: string;
  };

  let agentId = await runtime.ctx.storage.get<string>('agentId');

  if (!agentId && body.agentId) {
    agentId = body.agentId;
    const engine = createPaperEngine({
      balance: body.paperBalance,
      slippage: body.slippageSimulation,
    });
    await runtime.ctx.storage.put('agentId', agentId);
    await runtime.ctx.storage.put('engineState', engine.serialize());
    const analysisInterval = normalizeTradingInterval(body.analysisInterval ?? '1h');
    await runtime.ctx.storage.put('analysisInterval', analysisInterval);
  }

  if (!agentId) {
    return Response.json({ error: 'Agent not initialized. Start the agent first.' }, { status: 400 });
  }

  if (typeof body.analysisInterval === 'string' && body.analysisInterval.trim()) {
    await runtime.ctx.storage.put('analysisInterval', normalizeTradingInterval(body.analysisInterval));
  }

  const lockAt = await runtime.ctx.storage.get<number>('isLoopRunning');
  if (lockAt && Date.now() - lockAt < LOOP_LOCK_TTL_MS) {
    return Response.json({ error: 'Analysis already in progress' }, { status: 409 });
  }
  await runtime.ctx.storage.put('isLoopRunning', Date.now());

  const engine = await loadEngine(runtime.ctx.storage);

  try {
    await runAgentLoop(agentId, engine, runtime.env, runtime.ctx, { forceRun: true, bypassCache: true });
  } catch (err) {
    console.error(`[TradingAgentDO] manual analyze error for ${agentId}:`, err);
    await persistEngineState(runtime.ctx.storage, engine, `failed to persist engine state for ${agentId}`);
    await runtime.ctx.storage.delete('isLoopRunning');
    await runtime.rescheduleAlarmIfRunning();
    return Response.json({ error: String(err) }, { status: 500 });
  }

  await runtime.ctx.storage.delete('isLoopRunning');
  await persistEngineState(runtime.ctx.storage, engine, `failed to persist engine state for ${agentId}`);
  await runtime.rescheduleAlarmIfRunning();

  return Response.json({ ok: true });
}

async function handleSetInterval(runtime: TradingAgentRuntime, request: Request): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as { analysisInterval?: string };
  const interval = typeof body.analysisInterval === 'string' && body.analysisInterval.trim()
    ? normalizeTradingInterval(body.analysisInterval)
    : null;
  if (!interval) return Response.json({ error: 'analysisInterval is required' }, { status: 400 });

  await runtime.ctx.storage.put('analysisInterval', interval);

  const status = (await runtime.ctx.storage.get<string>('status')) ?? 'stopped';
  if (status === 'running') {
    const nextAlarmAt = Date.now() + intervalToMs(interval);
    await runtime.ctx.storage.put('nextAlarmAt', nextAlarmAt);
    await runtime.ctx.storage.setAlarm(nextAlarmAt);
  }

  return Response.json({ ok: true, analysisInterval: interval });
}

async function handleClearHistory(runtime: TradingAgentRuntime, request: Request): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as {
    agentId?: string;
    paperBalance?: number;
    slippageSimulation?: number;
    analysisInterval?: string;
  };

  const existingStatus = (await runtime.ctx.storage.get<string>('status')) ?? 'stopped';
  const storedAgentId = await runtime.ctx.storage.get<string>('agentId');
  if (!storedAgentId && typeof body.agentId === 'string' && body.agentId.trim()) {
    await runtime.ctx.storage.put('agentId', body.agentId.trim());
  }

  if (typeof body.analysisInterval === 'string' && body.analysisInterval.trim()) {
    await runtime.ctx.storage.put('analysisInterval', normalizeTradingInterval(body.analysisInterval));
  }

  const engine = createPaperEngine({
    balance: body.paperBalance,
    slippage: body.slippageSimulation,
  });
  await runtime.ctx.storage.put('engineState', engine.serialize());

  await runtime.ctx.storage.delete('tickCount');
  await runtime.ctx.storage.delete('pendingTrade');
  await runtime.ctx.storage.delete('lastStopOutAt');
  await runtime.ctx.storage.delete('isLoopRunning');
  await clearPriceMisses(runtime.ctx.storage);

  if (existingStatus === 'running') {
    const nextAlarmAt = Date.now() + 5_000;
    await runtime.ctx.storage.put('nextAlarmAt', nextAlarmAt);
    await runtime.ctx.storage.setAlarm(nextAlarmAt);
  }

  return Response.json({ ok: true, status: existingStatus });
}

async function handleReset(runtime: TradingAgentRuntime, request: Request): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as {
    paperBalance?: number;
    slippageSimulation?: number;
  };
  const engine = createPaperEngine({
    balance: body.paperBalance,
    slippage: body.slippageSimulation,
  });

  await runtime.ctx.storage.put('engineState', engine.serialize());
  await runtime.ctx.storage.put('status', 'stopped');
  await runtime.ctx.storage.deleteAlarm();
  await updateCachedAgentStatus(runtime.ctx.storage, 'stopped');
  return Response.json({ ok: true, balance: body.paperBalance ?? DEFAULT_BALANCE });
}

async function handleSetStatus(runtime: TradingAgentRuntime, status: 'stopped' | 'paused'): Promise<Response> {
  await runtime.ctx.storage.put('status', status);
  await runtime.ctx.storage.deleteAlarm();
  await updateCachedAgentStatus(runtime.ctx.storage, status);
  return Response.json({ ok: true, status });
}

async function handleClosePosition(runtime: TradingAgentRuntime, request: Request): Promise<Response> {
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

async function handleEngineState(runtime: TradingAgentRuntime): Promise<Response> {
  const engineState = await runtime.ctx.storage.get('engineState');
  return Response.json(engineState ?? null);
}

async function handleDebug(runtime: TradingAgentRuntime): Promise<Response> {
  const agentId = (await runtime.ctx.storage.get<string>('agentId')) ?? null;
  const status = (await runtime.ctx.storage.get<string>('status')) ?? 'stopped';
  const analysisInterval = (await runtime.ctx.storage.get<string>('analysisInterval')) ?? null;
  const nextAlarmAt = (await runtime.ctx.storage.get<number>('nextAlarmAt')) ?? null;
  const tickCount = (await runtime.ctx.storage.get<number>('tickCount')) ?? 0;
  const isLoopRunning = (await runtime.ctx.storage.get<number>('isLoopRunning')) ?? null;
  const lastStopOutAt = (await runtime.ctx.storage.get<number>('lastStopOutAt')) ?? null;
  const pendingTrade = (await runtime.ctx.storage.get<unknown>('pendingTrade')) ?? null;
  const engineState = await runtime.ctx.storage.get<{
    balance: number;
    initialBalance: number;
    positions: unknown[];
    closedPositions?: unknown[];
  }>('engineState');

  const priceMissMap: Record<string, number> = {};
  const priceMissKeys = await runtime.ctx.storage.list<number>({ prefix: 'priceMiss:' });
  for (const [key, val] of priceMissKeys) {
    priceMissMap[key] = val;
  }

  return Response.json({
    agentId,
    status,
    analysisInterval,
    nextAlarmAt,
    tickCount,
    isLoopRunning,
    lastStopOutAt,
    pendingTrade,
    priceMisses: priceMissMap,
    engine: engineState
      ? {
          balance: engineState.balance,
          initialBalance: engineState.initialBalance,
          openPositions: engineState.positions.length,
          closedPositions: engineState.closedPositions?.length ?? 0,
        }
      : null,
    generatedAt: new Date().toISOString(),
  });
}

async function handleReceiveDecision(runtime: TradingAgentRuntime, request: Request): Promise<Response> {
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

async function handleSyncConfig(runtime: TradingAgentRuntime, request: Request): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as { agentRow?: CachedAgentRow };
  if (body.agentRow) {
    const currentStatus = (await runtime.ctx.storage.get<string>('status')) ?? 'stopped';
    await syncCachedAgentRow(runtime.ctx.storage, body.agentRow, currentStatus);
  }

  return Response.json({ ok: true });
}
