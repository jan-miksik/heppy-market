import { generateText } from 'ai';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { TradeDecisionSchema } from '@dex-agents/shared';
import type { TradeDecision, AgentBehaviorConfig } from '@dex-agents/shared';
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
  /** Request timeout in ms; prevents analysis from hanging (default 90_000). */
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
  behavior?: Partial<AgentBehaviorConfig>;
  personaMd?: string | null;
}

const JSON_SCHEMA_INSTRUCTION = `
IMPORTANT: Respond with ONLY a valid JSON object — no markdown, no code blocks, no explanation.
The JSON must match this schema exactly:
{
  "action": "buy" | "sell" | "hold" | "close",
  "confidence": <number 0.0–1.0>,
  "reasoning": "<string>",
  "targetPair": "<string, optional>",
  "suggestedPositionSizePct": <number 0–100, optional>
}`;

/**
 * Extract a JSON object from raw LLM text.
 * Handles: plain JSON, markdown code blocks, reasoning tags (<think>...</think>).
 */
function extractJson(text: string): string {
  // Strip markdown code fences
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fenced) return fenced[1].trim();

  // Strip reasoning tags (DeepSeek, etc.)
  text = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

  // Extract first top-level JSON object
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end > start) return text.slice(start, end + 1);

  return text.trim();
}

function getSystemPrompt(autonomyLevel: string): string {
  switch (autonomyLevel) {
    case 'full':
      return FULL_AUTONOMY_PROMPT + JSON_SCHEMA_INSTRUCTION;
    case 'strict':
      return STRICT_RULES_PROMPT + JSON_SCHEMA_INSTRUCTION;
    default:
      return GUIDED_PROMPT + JSON_SCHEMA_INSTRUCTION;
  }
}

const DEFAULT_LLM_TIMEOUT_MS = 90_000;

/**
 * Get a structured trade decision from the LLM.
 *
 * Uses generateText + manual JSON extraction instead of generateObject, because
 * generateObject sends `json_schema` with strict:true which most free OpenRouter
 * models don't support. Plain text generation + prompt-based JSON works universally.
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

  // Emergency free models tried last when allowFallback is enabled.
  // Verified working as of 2026-02-24.
  const EMERGENCY_FREE_MODELS = [
    'arcee-ai/trinity-large-preview:free',
    'google/gemma-3-27b-it:free',
    'google/gemma-3-12b-it:free',
    'google/gemma-3-4b-it:free',
    'google/gemma-3n-e4b-it:free',
    'google/gemma-3n-e2b-it:free',
  ];

  const modelsToTry: string[] = [config.model];
  if (config.allowFallback && config.fallbackModel && config.fallbackModel !== config.model) {
    modelsToTry.push(config.fallbackModel);
  }
  if (config.allowFallback) {
    for (const m of EMERGENCY_FREE_MODELS) {
      if (!modelsToTry.includes(m)) modelsToTry.push(m);
    }
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
        generateText({
          model: openrouter(modelId),
          // Merge system into prompt — some models (e.g. Gemma) reject the system role
          prompt: `${systemPrompt}\n\n${userPrompt}`,
          ...(config.temperature !== undefined ? { temperature: config.temperature } : {}),
          maxRetries: 0,
        }),
        timeoutPromise,
      ]);

      const json = extractJson(result.text ?? '');
      if (!json.trim()) {
        throw new Error(`Model returned empty response`);
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(json);
      } catch (parseErr) {
        throw new Error(
          `Model returned invalid JSON: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}. Raw length: ${json.length}`
        );
      }
      const object = TradeDecisionSchema.parse(parsed);
      const latencyMs = Date.now() - startTime;

      return {
        ...object,
        latencyMs,
        tokensUsed: result.usage?.totalTokens,
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
