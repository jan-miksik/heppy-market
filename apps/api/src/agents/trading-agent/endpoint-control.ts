import { intervalToMs, normalizeTradingInterval } from '@something-in-loop/shared';
import { runAgentLoop } from '../agent-loop.js';
import { clearPriceMisses, syncCachedAgentRow, updateCachedAgentStatus } from './cache.js';
import {
  DEFAULT_BALANCE,
  LOOP_LOCK_TTL_MS,
  createPaperEngine,
  loadEngine,
  persistEngineState,
} from './state.js';
import type { CachedAgentRow, TradingAgentRuntime } from './types.js';

export async function handleStart(runtime: TradingAgentRuntime, request: Request): Promise<Response> {
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

export async function handleAnalyze(runtime: TradingAgentRuntime, request: Request): Promise<Response> {
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

export async function handleSetInterval(runtime: TradingAgentRuntime, request: Request): Promise<Response> {
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

export async function handleClearHistory(runtime: TradingAgentRuntime, request: Request): Promise<Response> {
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

export async function handleReset(runtime: TradingAgentRuntime, request: Request): Promise<Response> {
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

export async function handleSetStatus(runtime: TradingAgentRuntime, status: 'stopped' | 'paused'): Promise<Response> {
  await runtime.ctx.storage.put('status', status);
  await runtime.ctx.storage.deleteAlarm();
  await updateCachedAgentStatus(runtime.ctx.storage, status);
  return Response.json({ ok: true, status });
}

export async function handleSyncConfig(runtime: TradingAgentRuntime, request: Request): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as { agentRow?: CachedAgentRow };
  if (body.agentRow) {
    const currentStatus = (await runtime.ctx.storage.get<string>('status')) ?? 'stopped';
    await syncCachedAgentRow(runtime.ctx.storage, body.agentRow, currentStatus);
  }

  return Response.json({ ok: true });
}
