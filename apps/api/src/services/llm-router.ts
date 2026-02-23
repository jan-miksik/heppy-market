import { generateObject } from 'ai';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { TradeDecisionSchema } from '@dex-agents/shared';
import type { TradeDecision } from '@dex-agents/shared';
import { sleep } from '../lib/utils.js';
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
  temperature?: number;
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

  // Free models with tool-calling support, tried in order.
  // The user-configured model and fallback come first, then emergency backups.
  // Only models that support tool calling (required for generateObject).
  const EMERGENCY_FALLBACKS = [
    'nvidia/nemotron-3-nano-30b-a3b:free',
    'stepfun/step-3.5-flash:free',
    'arcee-ai/trinity-large-preview:free',
    'liquid/lfm-2.5-1.2b-thinking:free',
    'liquid/lfm-2.5-1.2b-instruct:free',
    'arcee-ai/trinity-mini:free',
    'nousresearch/hermes-3-llama-3.1-405b:free',
    'qwen/qwen3-235b-a22b-thinking-2507:free',
    'meta-llama/llama-3.3-70b-instruct:free',
    'deepseek/deepseek-r1-0528:free',
    'google/gemma-3-27b-it:free',
    'qwen/qwen3-coder:free',
  ];
  const modelsToTry = [
    config.model,
    ...(config.fallbackModel ? [config.fallbackModel] : []),
    ...EMERGENCY_FALLBACKS.filter(
      (m) => m !== config.model && m !== config.fallbackModel
    ),
  ];

  let lastError: unknown;

  for (const modelId of modelsToTry) {
    try {
      const { object, usage } = await generateObject({
        model: openrouter(modelId),
        schema: TradeDecisionSchema,
        system: systemPrompt,
        prompt: userPrompt,
        ...(config.temperature !== undefined ? { temperature: config.temperature } : {}),
        maxRetries: 0, // SDK must not retry — we fall through to the next model on any error
      });

      const latencyMs = Date.now() - startTime;

      return {
        ...object,
        latencyMs,
        tokensUsed: usage?.totalTokens,
        modelUsed: modelId,
      };
    } catch (err) {
      lastError = err;
      console.warn(`[llm-router] Model ${modelId} failed:`, err);
      // Short pause before next model
      await sleep(300);
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
