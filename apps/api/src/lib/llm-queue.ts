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
import { drizzle } from 'drizzle-orm/d1';
import { eq } from 'drizzle-orm';
import { getTradeDecision } from '../services/llm-router.js';
import type { LlmJobMessage } from '../types/queue-types.js';
import type { LLMRouterConfig } from '../services/llm-router.js';
import type { Env } from '../types/env.js';
import { users } from '../db/schema.js';
import { resolveStoredOpenRouterKey } from './openrouter-key.js';
import { nowIso } from './utils.js';

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

/**
 * Re-resolve the LLM API key for a queue job.
 * The key is intentionally not stored in the queue message; we look it up from D1
 * using the agent owner's wallet address so secrets never travel through Queues.
 */
async function resolveApiKey(
  ownerAddress: string,
  provider: 'openrouter' | 'anthropic' | undefined,
  env: Env
): Promise<string> {
  const isAnthropic = provider === 'anthropic';
  if (isAnthropic) {
    return env.ANTHROPIC_API_KEY ?? '';
  }

  // OpenRouter path: prefer user's own key, fall back to server key
  if (!env.OPENROUTER_API_KEY) {
    console.error('[llm-queue] OPENROUTER_API_KEY not set — cannot resolve API key');
    return '';
  }

  let resolvedKey = env.OPENROUTER_API_KEY;
  if (ownerAddress) {
    const db = drizzle(env.DB);
    const [owner] = await db
      .select({ id: users.id, openRouterKey: users.openRouterKey })
      .from(users)
      .where(eq(users.walletAddress, ownerAddress.toLowerCase()));
    if (owner?.openRouterKey) {
      const resolved = await resolveStoredOpenRouterKey({
        storedKey: owner.openRouterKey,
        serverKey: env.OPENROUTER_API_KEY,
        encryptionSecret: env.KEY_ENCRYPTION_SECRET,
        logPrefix: '[llm-queue]',
        persistEncrypted: async (encryptedKey) => {
          await db
            .update(users)
            .set({ openRouterKey: encryptedKey, updatedAt: nowIso() })
            .where(eq(users.id, owner.id));
        },
      });
      resolvedKey = resolved.apiKey;
    }
  }
  return resolvedKey;
}

async function processLlmJob(
  message: Message<LlmJobMessage>,
  env: Env
): Promise<void> {
  const { agentId, jobId, llmConfig: jobConfig, tradeRequest } = message.body;

  const apiKey = await resolveApiKey(jobConfig.ownerAddress, jobConfig.provider, env);
  if (!apiKey) {
    console.error(`[llm-queue] Could not resolve API key for agent=${agentId} job=${jobId}`);
    message.retry();
    return;
  }

  // Reconstruct the full LLM config with the resolved key
  const llmConfig: LLMRouterConfig = {
    ...jobConfig,
    apiKey,
  };

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
