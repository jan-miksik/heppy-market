import { intervalToMs } from '@something-in-loop/shared';
import { runAgentLoop } from '../agent-loop.js';
import { savePerformanceSnapshot } from './persistence.js';
import { LOOP_LOCK_TTL_MS, PENDING_LLM_TTL_MS, loadEngine, persistEngineState } from './state.js';
import type { TradingAgentRuntime } from './types.js';

export async function rescheduleAlarmIfRunning(runtime: TradingAgentRuntime): Promise<void> {
  try {
    const status = (await runtime.ctx.storage.get<string>('status')) ?? 'stopped';
    if (status === 'running') {
      const interval = (await runtime.ctx.storage.get<string>('analysisInterval')) ?? '1h';
      const nextAlarmAt = Date.now() + intervalToMs(interval);
      await runtime.ctx.storage.put('nextAlarmAt', nextAlarmAt);
      await runtime.ctx.storage.setAlarm(nextAlarmAt);
    }
  } catch (err) {
    console.error('[TradingAgentDO] CRITICAL: failed to reschedule alarm:', err);
  }
}

export async function handleAlarm(runtime: TradingAgentRuntime): Promise<void> {
  const status = (await runtime.ctx.storage.get<string>('status')) ?? 'stopped';
  if (status !== 'running') return;

  const agentId = await runtime.ctx.storage.get<string>('agentId');
  if (!agentId) return;

  const pendingJobAt = await runtime.ctx.storage.get<number>('pendingLlmJobAt');
  if (pendingJobAt && Date.now() - pendingJobAt < PENDING_LLM_TTL_MS) {
    const pendingJobId = await runtime.ctx.storage.get<string>('pendingLlmJobId');
    console.log(`[TradingAgentDO] ${agentId}: awaiting LLM result for job ${pendingJobId}, skipping alarm tick`);
    await runtime.rescheduleAlarmIfRunning();
    return;
  }

  const lockAt = await runtime.ctx.storage.get<number>('isLoopRunning');
  if (lockAt && Date.now() - lockAt < LOOP_LOCK_TTL_MS) {
    console.warn(`[TradingAgentDO] ${agentId}: Loop already running, skipping alarm tick`);
    await runtime.rescheduleAlarmIfRunning();
    return;
  }
  await runtime.ctx.storage.put('isLoopRunning', Date.now());

  try {
    const engine = await loadEngine(runtime.ctx.storage);

    try {
      await runAgentLoop(agentId, engine, runtime.env, runtime.ctx);
    } catch (err) {
      console.error(`[TradingAgentDO] alarm error for ${agentId}:`, err);
    }

    await persistEngineState(runtime.ctx.storage, engine, `failed to persist engine state for ${agentId}`);

    const tickCount = ((await runtime.ctx.storage.get<number>('tickCount')) ?? 0) + 1;
    await runtime.ctx.storage.put('tickCount', tickCount);

    if (tickCount % 6 === 0) {
      await savePerformanceSnapshot(runtime.env, agentId, engine);
    }
  } catch (err) {
    console.error(`[TradingAgentDO] unexpected alarm error for ${agentId}:`, err);
  } finally {
    await runtime.ctx.storage.delete('isLoopRunning');
    try {
      const currentStatus = (await runtime.ctx.storage.get<string>('status')) ?? 'stopped';
      if (currentStatus === 'running') {
        const interval = (await runtime.ctx.storage.get<string>('analysisInterval')) ?? '1h';
        const nextAlarmAt = Date.now() + intervalToMs(interval);
        await runtime.ctx.storage.put('nextAlarmAt', nextAlarmAt);
        await runtime.ctx.storage.setAlarm(nextAlarmAt);
      }
    } catch (rescheduleErr) {
      console.error(`[TradingAgentDO] CRITICAL: failed to reschedule alarm for ${agentId}:`, rescheduleErr);
    }
  }
}
