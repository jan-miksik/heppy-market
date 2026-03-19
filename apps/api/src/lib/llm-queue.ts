/**
 * Cloudflare Queues consumer for async LLM decision processing.
 *
 * Flow:
 *   1. TradingAgentDO alarm fires → fetches market data → enqueues LlmJobMessage
 *   2. Queue consumer (this file) calls LLM, retrying up to max_retries on failure
 *   3. Successful decision POSTed back to DO via stub.fetch('/receive-decision')
 *   4. DO executes trade, logs decision, broadcasts WS events, reschedules alarm
 *
 * When LLM_QUEUE is NOT bound, agent-loop falls back to synchronous inline LLM calls.
 */
import { getTradeDecision } from '../services/llm-router.js';
import type { LlmJobMessage } from '../types/queue-types.js';
import type { Env } from '../types/env.js';

export type { LlmJobMessage } from '../types/queue-types.js';

/**
 * Queue consumer handler — processes one batch of LLM jobs.
 * Called by the Workers runtime when messages arrive on the "llm-jobs" queue.
 */
export async function handleLlmQueueBatch(
  batch: MessageBatch<LlmJobMessage>,
  env: Env
): Promise<void> {
  for (const message of batch.messages) {
    await processLlmJob(message, env);
  }
}

async function processLlmJob(
  message: Message<LlmJobMessage>,
  env: Env
): Promise<void> {
  const { agentId, jobId, llmConfig, tradeRequest } = message.body;

  let decision: Awaited<ReturnType<typeof getTradeDecision>>;
  try {
    decision = await getTradeDecision(llmConfig, tradeRequest);
  } catch (err) {
    console.error(
      `[llm-queue] LLM call failed for agent=${agentId} job=${jobId} attempt=${message.attempts}:`,
      err
    );
    // Cloudflare Queues retries with exponential backoff up to the max_retries
    // configured in wrangler.toml. After max_retries the message goes to the DLQ.
    message.retry();
    return;
  }

  // Deliver the result back to TradingAgentDO
  try {
    const doId = env.TRADING_AGENT.idFromName(agentId);
    const stub = env.TRADING_AGENT.get(doId);
    const res = await stub.fetch(
      new Request('http://do/receive-decision', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId, decision }),
      })
    );
    if (res.ok) {
      message.ack();
    } else {
      const text = await res.text().catch(() => '');
      console.error(
        `[llm-queue] DO rejected decision for agent=${agentId} (${res.status}): ${text}`
      );
      message.retry();
    }
  } catch (err) {
    console.error(`[llm-queue] Failed to deliver decision to DO for agent=${agentId}:`, err);
    message.retry();
  }
}
