import { generateText } from 'ai';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { createAnthropic } from '@ai-sdk/anthropic';
import { TradeDecisionSchema, PerpTradeDecisionSchema } from '@something-in-loop/shared';
import type { TradeDecision, PerpTradeDecision, AgentBehaviorConfig } from '@something-in-loop/shared';
import { sleep } from '../lib/utils.js';
import { classifyLlmError } from '../lib/agent-errors.js';
import { BASE_AGENT_PROMPT, buildAnalysisPrompt, buildPerpAnalysisPrompt } from '../agents/prompts.js';

export function buildJsonSchemaInstruction(): string {
  return `
IMPORTANT: Respond with ONLY a valid JSON object — no markdown, no code blocks, no explanation.
The JSON must match this schema exactly:
{
  "action": "buy" | "sell" | "hold" | "close",
  "confidence": <number 0.0–1.0>,
  "reasoning": "<string>",
  "targetPair": "<string, optional>",
  "suggestedPositionSizePct": <number 0–100, optional>
}`;
}

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
  /** Override the provider. Defaults to 'openrouter'. Use 'anthropic' for Claude models with a sk-ant-* key. */
  provider?: 'openrouter' | 'anthropic';
  /** When true, logs full prompt text for debugging (never enable in production). */
  debugLogging?: boolean;
}

export interface TradeDecisionRequest {
  portfolioState: {
    balance: number;
    openPositions: number;
    dailyPnlPct: number;
    totalPnlPct: number;
  };
  openPositions: Array<{
    pair: string;
    side: 'buy' | 'sell';
    entryPrice: number;
    amountUsd: number;
    unrealizedPct: number;
    currentPrice: number;
    openedAt: string;
    slPct: number;
    tpPct: number;
  }>;
  marketData: Array<{
    pair: string;
    priceUsd: number;
    priceChange: Record<string, number | undefined>;
    volume24h?: number;
    liquidity?: number;
    indicatorText: string;
    dailyIndicatorText?: string;
  }>;
  lastDecisions: Array<{
    decision: string;
    confidence: number;
    createdAt: string;
  }>;
  config: {
    pairs: string[];
    maxPositionSizePct: number;
    maxOpenPositions: number;
    stopLossPct: number;
    takeProfitPct: number;
  };
  behavior?: Partial<AgentBehaviorConfig>;
  personaMd?: string | null;
  behaviorMd?: string | null;
  roleMd?: string | null;
}

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

const DEFAULT_LLM_TIMEOUT_MS = 90_000;
/** Shorter timeout used for emergency fallback models (lower quality bar, faster fail) */
const EMERGENCY_MODEL_TIMEOUT_MS = 30_000;
const LLM_LOG_PROMPT_PREVIEW_MAX_CHARS = 800;

function previewPromptForLogs(text: string): string {
  if (text.length <= LLM_LOG_PROMPT_PREVIEW_MAX_CHARS) return text;
  return `${text.slice(0, LLM_LOG_PROMPT_PREVIEW_MAX_CHARS)}\n...[truncated ${text.length - LLM_LOG_PROMPT_PREVIEW_MAX_CHARS} chars]`;
}

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
): Promise<
  TradeDecision & {
    latencyMs: number;
    tokensUsed?: number;
    tokensIn?: number;
    tokensOut?: number;
    modelUsed: string;
    llmPromptText: string;
    llmRawResponse: string;
  }
> {
  const isAnthropic = config.provider === 'anthropic';
  const openrouter = isAnthropic ? null : createOpenRouter({ apiKey: config.apiKey });
  const anthropic = isAnthropic ? createAnthropic({ apiKey: config.apiKey }) : null;
  const systemPrompt = BASE_AGENT_PROMPT + buildJsonSchemaInstruction();
  const userPrompt = buildAnalysisPrompt({
    portfolioState: request.portfolioState,
    openPositions: request.openPositions,
    marketData: request.marketData,
    lastDecisions: request.lastDecisions,
    config: request.config,
    behavior: request.behavior,
    personaMd: request.personaMd,
    behaviorMd: request.behaviorMd,
    roleMd: request.roleMd,
  });

  const startTime = Date.now();
  const timeoutMs = config.timeoutMs ?? DEFAULT_LLM_TIMEOUT_MS;

  // Emergency free models tried last when allowFallback is enabled.
  // Verified working as of 2026-02-24.
  const EMERGENCY_FREE_MODELS = [
    'qwen/qwen3-coder:free',
    'arcee-ai/trinity-large-preview:free',
    'google/gemma-3-27b-it:free',
    'google/gemma-3-12b-it:free',
    'google/gemma-3-4b-it:free',
  ];

  const primaryModels: string[] = [config.model];
  if (config.allowFallback && config.fallbackModel && config.fallbackModel !== config.model) {
    primaryModels.push(config.fallbackModel);
  }
  // Anthropic provider: no free emergency fallbacks (paid key, no OpenRouter fallback)
  const emergencyModels: string[] = [];
  if (config.allowFallback && !isAnthropic) {
    for (const m of EMERGENCY_FREE_MODELS) {
      if (!primaryModels.includes(m)) emergencyModels.push(m);
    }
  }
  const modelsToTry = [...primaryModels, ...emergencyModels];
  const primaryModelSet = new Set(primaryModels);

  let lastError: unknown;

  const fullPrompt = `${systemPrompt}\n\n${userPrompt}`;
  const debugLogging = config.debugLogging === true;

  /** Whether an error is transient enough to warrant a per-model retry */
  function isTransientError(err: unknown): boolean {
    const classified = classifyLlmError(err);
    return classified.code === 'LLM_TIMEOUT' ||
      classified.code === 'LLM_RATE_LIMIT' ||
      classified.code === 'LLM_NETWORK_ERROR';
  }

  for (const modelId of modelsToTry) {
    const effectiveTimeout = primaryModelSet.has(modelId) ? timeoutMs : EMERGENCY_MODEL_TIMEOUT_MS;
    // Per-model retry: up to 2 retries for transient errors (timeout, rate-limit, network)
    const MAX_MODEL_RETRIES = primaryModelSet.has(modelId) ? 2 : 1;
    let modelAttempt = 0;

    while (modelAttempt <= MAX_MODEL_RETRIES) {
      try {
        const timeoutPromise = new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error(`Model request timed out after ${effectiveTimeout / 1000}s`)),
            effectiveTimeout
          )
        );

        const modelInstance = isAnthropic
          ? anthropic!(modelId)
          : openrouter!(modelId);

        if (modelAttempt === 0) {
          console.log('[llm-router] Model:', modelId);
          console.log('[llm-router] Prompt length (chars):', fullPrompt.length);
          if (debugLogging) {
            console.log('[llm-router] === PROMPT SENT TO LLM ===');
            console.log('[llm-router] --- USER PROMPT ---');
            console.log(userPrompt);
            console.log('[llm-router] === END PROMPT ===');
          } else {
            console.log('[llm-router] User prompt preview:');
            console.log(previewPromptForLogs(userPrompt));
          }
        } else {
          console.log(`[llm-router] Retry ${modelAttempt}/${MAX_MODEL_RETRIES} for model ${modelId}`);
        }

        const result = await Promise.race([
          generateText({
            model: modelInstance,
            // Merge system into prompt — some models (e.g. Gemma) reject the system role.
            // Anthropic also handles a flat prompt just fine.
            prompt: fullPrompt,
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
        const usage = (result as any).usage ?? {};

        return {
          ...object,
          targetPair: object.targetPair ?? undefined,
          suggestedPositionSizePct: object.suggestedPositionSizePct ?? undefined,
          latencyMs,
          tokensUsed: usage.totalTokens,
          tokensIn: usage.inputTokens,
          tokensOut: usage.outputTokens,
          modelUsed: modelId,
          llmPromptText: fullPrompt,
          llmRawResponse: result.text ?? '',
        };
      } catch (err) {
        lastError = err;
        const isTransient = isTransientError(err);
        const classified = classifyLlmError(err, { model: modelId, attempt: modelAttempt });
        console.warn(
          `[llm-router] model=${modelId} attempt=${modelAttempt} error_code=${classified.code} message=${classified.message}`
        );

        if (isTransient && modelAttempt < MAX_MODEL_RETRIES) {
          // Exponential backoff: 500ms, 1000ms
          const backoffMs = 500 * Math.pow(2, modelAttempt);
          console.log(`[llm-router] Transient error — retrying in ${backoffMs}ms`);
          await sleep(backoffMs);
          modelAttempt++;
          continue;
        }
        // Non-transient or out of retries — move to next model
        break;
      }
    }

    // Brief pause between different models
    if (modelsToTry.indexOf(modelId) < modelsToTry.length - 1) {
      await sleep(300);
    }
  }

  const msg =
    modelsToTry.length === 1
      ? `Model "${modelsToTry[0]}" is unavailable. ${String(lastError)}`
      : `Primary and fallback models failed. Last error: ${String(lastError)}`;
  throw new Error(msg);
}

export function buildPerpJsonSchemaInstruction(): string {
  return `
IMPORTANT: Respond with ONLY a valid JSON object — no markdown, no code blocks, no explanation.
The JSON must match this schema exactly:
{
  "action": "OPEN_LONG" | "OPEN_SHORT" | "CLOSE_LONG" | "CLOSE_SHORT" | "HOLD",
  "market": "<string — e.g. BTC/USD>",
  "confidence": <number 0.0–1.0>,
  "sizePct": <number 0–100 — % of balance to use for OPEN actions; 0 for CLOSE/HOLD>,
  "maxSlippageBps": <integer 0–10000 — acceptable slippage in basis points>,
  "rationale": "<string — 1–2 sentence explanation>"
}
Do NOT include calldata, token addresses, function selectors, or deadlines — the backend generates those.`;
}

export interface PerpTradeDecisionRequest {
  portfolioState: {
    balance: number;
    openPositions: number;
    dailyPnlPct: number;
    totalPnlPct: number;
  };
  currentPositionState: 'FLAT' | 'LONG' | 'SHORT';
  marketData: Array<{
    pair: string;
    priceUsd: number;
    priceChange: Record<string, number | undefined>;
    volume24h?: number;
    liquidity?: number;
    indicatorText: string;
    dailyIndicatorText?: string;
  }>;
  lastDecisions: Array<{
    decision: string;
    confidence: number;
    createdAt: string;
  }>;
  config: {
    pairs: string[];
    maxPositionSizePct: number;
  };
  behavior?: Partial<AgentBehaviorConfig>;
  personaMd?: string | null;
  behaviorMd?: string | null;
  roleMd?: string | null;
}

/**
 * Get a structured perpetual trade decision from the LLM.
 * Uses PerpTradeDecisionSchema.
 * Mirrors getTradeDecision — same model-fallback and retry strategy.
 */
export async function getPerpTradeDecision(
  config: LLMRouterConfig,
  request: PerpTradeDecisionRequest,
): Promise<
  PerpTradeDecision & {
    latencyMs: number;
    tokensUsed?: number;
    tokensIn?: number;
    tokensOut?: number;
    modelUsed: string;
    llmPromptText: string;
    llmRawResponse: string;
  }
> {
  const isAnthropic = config.provider === 'anthropic';
  const openrouter = isAnthropic ? null : createOpenRouter({ apiKey: config.apiKey });
  const anthropic = isAnthropic ? createAnthropic({ apiKey: config.apiKey }) : null;
  const systemPrompt = BASE_AGENT_PROMPT + buildPerpJsonSchemaInstruction();
  const userPrompt = buildPerpAnalysisPrompt({
    portfolioState: request.portfolioState,
    currentPositionState: request.currentPositionState,
    marketData: request.marketData,
    lastDecisions: request.lastDecisions,
    config: request.config,
    behavior: request.behavior,
    personaMd: request.personaMd,
    behaviorMd: request.behaviorMd,
    roleMd: request.roleMd,
  });

  const startTime = Date.now();
  const timeoutMs = config.timeoutMs ?? DEFAULT_LLM_TIMEOUT_MS;

  const EMERGENCY_FREE_MODELS = [
    'qwen/qwen3-coder:free',
    'arcee-ai/trinity-large-preview:free',
    'google/gemma-3-27b-it:free',
    'google/gemma-3-12b-it:free',
    'google/gemma-3-4b-it:free',
  ];

  const primaryModels: string[] = [config.model];
  if (config.allowFallback && config.fallbackModel && config.fallbackModel !== config.model) {
    primaryModels.push(config.fallbackModel);
  }
  const emergencyModels: string[] = [];
  if (config.allowFallback && !isAnthropic) {
    for (const m of EMERGENCY_FREE_MODELS) {
      if (!primaryModels.includes(m)) emergencyModels.push(m);
    }
  }
  const modelsToTry = [...primaryModels, ...emergencyModels];
  const primaryModelSet = new Set(primaryModels);

  let lastError: unknown;
  const fullPrompt = `${systemPrompt}\n\n${userPrompt}`;
  const debugLogging = config.debugLogging === true;

  function isTransientError(err: unknown): boolean {
    const classified = classifyLlmError(err);
    return (
      classified.code === 'LLM_TIMEOUT' ||
      classified.code === 'LLM_RATE_LIMIT' ||
      classified.code === 'LLM_NETWORK_ERROR'
    );
  }

  for (const modelId of modelsToTry) {
    const effectiveTimeout = primaryModelSet.has(modelId) ? timeoutMs : EMERGENCY_MODEL_TIMEOUT_MS;
    const MAX_MODEL_RETRIES = primaryModelSet.has(modelId) ? 2 : 1;
    let modelAttempt = 0;

    while (modelAttempt <= MAX_MODEL_RETRIES) {
      try {
        const timeoutPromise = new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error(`Model request timed out after ${effectiveTimeout / 1000}s`)),
            effectiveTimeout,
          ),
        );

        const modelInstance = isAnthropic ? anthropic!(modelId) : openrouter!(modelId);

        if (modelAttempt === 0) {
          console.log('[llm-router:perp] Model:', modelId);
          console.log('[llm-router:perp] Prompt length (chars):', fullPrompt.length);
          if (debugLogging) {
            console.log('[llm-router:perp] === PROMPT SENT TO LLM ===');
            console.log(userPrompt);
            console.log('[llm-router:perp] === END PROMPT ===');
          } else {
            console.log('[llm-router:perp] User prompt preview:');
            console.log(previewPromptForLogs(userPrompt));
          }
        } else {
          console.log(
            `[llm-router:perp] Retry ${modelAttempt}/${MAX_MODEL_RETRIES} for model ${modelId}`,
          );
        }

        const result = await Promise.race([
          generateText({
            model: modelInstance,
            prompt: fullPrompt,
            ...(config.temperature !== undefined ? { temperature: config.temperature } : {}),
            maxRetries: 0,
          }),
          timeoutPromise,
        ]);

        const json = extractJson(result.text ?? '');
        if (!json.trim()) throw new Error('Model returned empty response');
        let parsed: unknown;
        try {
          parsed = JSON.parse(json);
        } catch (parseErr) {
          throw new Error(
            `Model returned invalid JSON: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}. Raw length: ${json.length}`,
          );
        }
        const object = PerpTradeDecisionSchema.parse(parsed);
        const latencyMs = Date.now() - startTime;
        const usage = (result as any).usage ?? {};

        return {
          ...object,
          latencyMs,
          tokensUsed: usage.totalTokens,
          tokensIn: usage.inputTokens,
          tokensOut: usage.outputTokens,
          modelUsed: modelId,
          llmPromptText: fullPrompt,
          llmRawResponse: result.text ?? '',
        };
      } catch (err) {
        lastError = err;
        const isTransient = isTransientError(err);
        const classified = classifyLlmError(err, { model: modelId, attempt: modelAttempt });
        console.warn(
          `[llm-router:perp] model=${modelId} attempt=${modelAttempt} error_code=${classified.code} message=${classified.message}`,
        );

        if (isTransient && modelAttempt < MAX_MODEL_RETRIES) {
          const backoffMs = 500 * Math.pow(2, modelAttempt);
          console.log(`[llm-router:perp] Transient error — retrying in ${backoffMs}ms`);
          await sleep(backoffMs);
          modelAttempt++;
          continue;
        }
        break;
      }
    }

    if (modelsToTry.indexOf(modelId) < modelsToTry.length - 1) {
      await sleep(300);
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
  try {
    const cached = await cache.get(cacheKey, 'text');
    if (cached) {
      return JSON.parse(cached) as Array<{ id: string; name: string; context: number }>;
    }
  } catch (err) {
    console.warn('[llm-router] free-model cache get failed:', err);
  }

  const response = await fetch('https://openrouter.ai/api/v1/models', {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'HTTP-Referer': 'https://something-in-loop.dev',
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

  try {
    await cache.put(cacheKey, JSON.stringify(freeModels), {
      expirationTtl: 86400, // 24h — model list changes at most daily
    });
  } catch (err) {
    console.warn('[llm-router] free-model cache put failed:', err);
  }

  return freeModels;
}
