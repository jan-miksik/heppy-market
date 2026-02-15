import { generateObject } from 'ai';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { z } from 'zod';
import { TradeDecisionSchema } from '@dex-agents/shared';
import type { TradeDecision } from '@dex-agents/shared';
import { retry, sleep } from '../lib/utils.js';
import {
  FULL_AUTONOMY_PROMPT,
  GUIDED_PROMPT,
  STRICT_RULES_PROMPT,
  buildAnalysisPrompt,
} from '../agents/prompts.js';

export interface LLMRouterConfig {
  apiKey: string;
  model: string;
  fallbackModel?: string;
  maxRetries?: number;
}

export interface TradeDecisionRequest {
  autonomyLevel: 'full' | 'guided' | 'strict';
  portfolioState: {
    balance: number;
    openPositions: number;
    dailyPnlPct: number;
    totalPnlPct: number;
  };
  marketData: Array<{
    pair: string;
    priceUsd: number;
    priceChange: Record<string, number | undefined>;
    volume24h?: number;
    liquidity?: number;
    indicators?: Record<string, unknown>;
  }>;
  lastDecisions: Array<{
    decision: string;
    confidence: number;
    createdAt: string;
  }>;
  config: {
    pairs: string[];
    maxPositionSizePct: number;
    strategies: string[];
  };
}

function getSystemPrompt(autonomyLevel: string): string {
  switch (autonomyLevel) {
    case 'full':
      return FULL_AUTONOMY_PROMPT;
    case 'strict':
      return STRICT_RULES_PROMPT;
    default:
      return GUIDED_PROMPT;
  }
}

/**
 * Get a structured trade decision from the LLM.
 * Implements fallback model logic and exponential backoff retries.
 */
export async function getTradeDecision(
  config: LLMRouterConfig,
  request: TradeDecisionRequest
): Promise<TradeDecision & { latencyMs: number; tokensUsed?: number; modelUsed: string }> {
  const openrouter = createOpenRouter({ apiKey: config.apiKey });
  const systemPrompt = getSystemPrompt(request.autonomyLevel);
  const userPrompt = buildAnalysisPrompt({
    systemPrompt,
    ...request,
  });

  const startTime = Date.now();
  const modelsToTry = [
    config.model,
    ...(config.fallbackModel ? [config.fallbackModel] : []),
  ];

  let lastError: unknown;

  for (const modelId of modelsToTry) {
    try {
      const result = await retry(
        async () => {
          const { object, usage } = await generateObject({
            model: openrouter(modelId),
            schema: TradeDecisionSchema,
            system: systemPrompt,
            prompt: userPrompt,
          });
          return { object, usage };
        },
        config.maxRetries ?? 2,
        1500
      );

      const latencyMs = Date.now() - startTime;

      return {
        ...result.object,
        latencyMs,
        tokensUsed: result.usage?.totalTokens,
        modelUsed: modelId,
      };
    } catch (err) {
      lastError = err;
      console.warn(`[llm-router] Model ${modelId} failed:`, err);
      // Brief pause before trying fallback
      await sleep(500);
    }
  }

  throw new Error(
    `All LLM models failed. Last error: ${String(lastError)}`
  );
}

/**
 * List available free models from OpenRouter.
 * Cached in KV for 1 hour.
 */
export async function listFreeModels(
  apiKey: string,
  cache: KVNamespace
): Promise<Array<{ id: string; name: string; context: number }>> {
  const cacheKey = 'llm:free-models';
  const cached = await cache.get(cacheKey, 'text');
  if (cached) {
    return JSON.parse(cached) as Array<{ id: string; name: string; context: number }>;
  }

  const response = await fetch('https://openrouter.ai/api/v1/models', {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'HTTP-Referer': 'https://dex-trading-agents.dev',
    },
  });

  if (!response.ok) {
    throw new Error(`OpenRouter models API error: ${response.status}`);
  }

  const data = (await response.json()) as {
    data: Array<{ id: string; name: string; context_length: number; pricing: { prompt: string } }>;
  };

  const freeModels = data.data
    .filter((m) => parseFloat(m.pricing.prompt) === 0)
    .map((m) => ({ id: m.id, name: m.name, context: m.context_length }));

  await cache.put(cacheKey, JSON.stringify(freeModels), {
    expirationTtl: 3600,
  });

  return freeModels;
}
