import { AgentConfigSchema } from '@something-in-loop/shared';
import type { TradeDecisionRequest } from '../../services/llm-router.js';
import type { LlmJobMessage } from '../../types/queue-types.js';
import { generateId } from '../../lib/utils.js';
import { createLogger } from '../../lib/logger.js';
import type { Env } from '../../types/env.js';
import type { MarketDataItem, PendingLlmContext } from './types.js';

type EnqueueLlmJobParams = {
  agentId: string;
  ownerAddress: string | null;
  env: Env;
  ctx: DurableObjectState;
  log: ReturnType<typeof createLogger>;
  marketData: MarketDataItem[];
  pairsToFetch: string[];
  effectiveLlmModel: string;
  effectiveLlmFallback: string;
  allowFallback: boolean;
  llmProvider: 'openrouter' | 'anthropic';
  minConfidence: number;
  tradeRequest: TradeDecisionRequest;
  config: ReturnType<typeof AgentConfigSchema.parse>;
};

/**
 * Enqueues async LLM work and stores context for /receive-decision.
 * Returns true when a job was enqueued or skipped due to an in-flight job.
 * Returns false when queue path is disabled and caller should use sync path.
 */
export async function enqueueLlmJob(params: EnqueueLlmJobParams): Promise<boolean> {
  const {
    agentId,
    ownerAddress,
    env,
    ctx,
    log,
    marketData,
    pairsToFetch,
    effectiveLlmModel,
    effectiveLlmFallback,
    allowFallback,
    llmProvider,
    minConfidence,
    tradeRequest,
    config,
  } = params;

  if (!env.LLM_QUEUE) return false;

  const existingJobId = await ctx.storage.get<string>('pendingLlmJobId');
  if (existingJobId) {
    const jobAt = (await ctx.storage.get<number>('pendingLlmJobAt')) ?? 0;
    if (Date.now() - jobAt < 5 * 60_000) {
      log.info('llm_job_pending_skip', { jobId: existingJobId });
      return true;
    }
    log.warn('llm_job_stale_cleared', { jobId: existingJobId, ageMs: Date.now() - jobAt });
    await ctx.storage.delete('pendingLlmJobId');
    await ctx.storage.delete('pendingLlmJobAt');
    await ctx.storage.delete('pendingLlmContext');
  }

  const jobId = generateId('job');
  const pendingCtx: PendingLlmContext = {
    jobId,
    enqueuedAt: Date.now(),
    marketData,
    pairsToFetch,
    effectiveLlmModel,
    maxOpenPositions: config.maxOpenPositions,
    maxPositionSizePct: config.maxPositionSizePct,
    stopLossPct: config.stopLossPct,
    takeProfitPct: config.takeProfitPct,
    minConfidence,
    dexes: config.dexes,
    strategies: config.strategies,
    slippageSimulation: config.slippageSimulation,
  };
  await ctx.storage.put('pendingLlmContext', pendingCtx);
  await ctx.storage.put('pendingLlmJobId', jobId);
  await ctx.storage.put('pendingLlmJobAt', Date.now());

  const message: LlmJobMessage = {
    agentId,
    jobId,
    llmConfig: {
      // apiKey is intentionally omitted — the queue consumer re-resolves it from D1
      ownerAddress: ownerAddress ?? '',
      model: effectiveLlmModel,
      fallbackModel: effectiveLlmFallback,
      allowFallback,
      temperature: config.temperature,
      timeoutMs: 90_000,
      provider: llmProvider,
      debugLogging: env.LOG_LLM_DEBUG === 'true',
    },
    tradeRequest,
  };
  await env.LLM_QUEUE.send(message);
  log.info('llm_job_enqueued', { jobId, model: effectiveLlmModel });
  return true;
}
