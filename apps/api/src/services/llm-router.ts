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

/** When true, if the primary model fails we try the user-configured fallback model. No automatic emergency fallbacks. */
export interface LLMRouterConfig {
  apiKey: string;
  model: string;
  /** Only used when allowFallback is true (user consent). */
  fallbackModel?: string;
  allowFallback?: boolean;
  maxRetries?: number;
  temperature?: number;
  /** Request timeout in ms; prevents analysis from hanging (default 180_000). */
  timeoutMs?: number;
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

const DEFAULT_LLM_TIMEOUT_MS = 180_000;

/**
 * Get a structured trade decision from the LLM.
 * Only tries the user's selected model (and optionally fallback if allowFallback is true).
 * No automatic emergency fallbacks — if the model fails, we surface an error so the user can choose another model.
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
  const timeoutMs = config.timeoutMs ?? DEFAULT_LLM_TIMEOUT_MS;

  // Only user-selected model; fallback only if user explicitly consented (allowFallback).
  const modelsToTry: string[] = [config.model];
  if (config.allowFallback && config.fallbackModel && config.fallbackModel !== config.model) {
    modelsToTry.push(config.fallbackModel);
  }

  let lastError: unknown;

  for (const modelId of modelsToTry) {
    try {
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`Model request timed out after ${timeoutMs / 1000}s`)),
          timeoutMs
        )
      );

      const result = await Promise.race([
        generateObject({
          model: openrouter(modelId),
          schema: TradeDecisionSchema,
          system: systemPrompt,
          prompt: userPrompt,
          ...(config.temperature !== undefined ? { temperature: config.temperature } : {}),
          maxRetries: 0,
        }),
        timeoutPromise,
      ]);

      const { object, usage } = result;
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
      if (modelsToTry.indexOf(modelId) < modelsToTry.length - 1) {
        await sleep(300);
      }
    }
  }

  const msg =
    modelsToTry.length === 1
      ? `Model "${modelsToTry[0]}" is unavailable. ${String(lastError)}`
      : `Primary and fallback models failed. Last error: ${String(lastError)}`;
  throw new Error(msg);
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
