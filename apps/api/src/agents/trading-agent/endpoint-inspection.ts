import type { TradingAgentRuntime } from './types.js';

export async function handleStatus(runtime: TradingAgentRuntime): Promise<Response> {
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

export async function handleEngineState(runtime: TradingAgentRuntime): Promise<Response> {
  const engineState = await runtime.ctx.storage.get('engineState');
  return Response.json(engineState ?? null);
}

export async function handleDebug(runtime: TradingAgentRuntime): Promise<Response> {
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
