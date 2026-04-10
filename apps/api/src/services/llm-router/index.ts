import { generateText } from 'ai';
import { sleep } from '../../lib/utils.js';
import { classifyLlmError } from '../../lib/agent-errors.js';
import {
  buildModelsToTry,
  createModelResolver,
  DEFAULT_LLM_TIMEOUT_MS,
  EMERGENCY_MODEL_TIMEOUT_MS,
  isTransientError,
} from './provider-selection.js';
import {
  buildPerpJsonSchemaInstruction,
  buildPerpTradeDecisionPrompt,
  buildTradeDecisionPrompt,
  previewPromptForLogs,
} from './request-builders.js';
import { parsePerpTradeDecisionResponse, parseTradeDecisionResponse } from './response-parsers.js';
import type {
  LLMRouterConfig,
  LlmDecisionMetadata,
  PerpTradeDecisionRequest,
  PerpTradeDecisionResult,
  TradeDecisionRequest,
  TradeDecisionResult,
} from './types.js';

export type { LLMRouterConfig, PerpTradeDecisionRequest, TradeDecisionRequest } from './types.js';
export { buildPerpJsonSchemaInstruction } from './request-builders.js';

/**
 * Get a structured trade decision from the LLM.
 *
 * Uses generateText + manual JSON extraction instead of generateObject, because
 * generateObject sends `json_schema` with strict:true which most free OpenRouter
 * models don't support. Plain text generation + prompt-based JSON works universally.
 */
export async function getTradeDecision(
  config: LLMRouterConfig,
  request: TradeDecisionRequest,
): Promise<TradeDecisionResult> {
  const prompt = buildTradeDecisionPrompt(request);
  const result = await runStructuredDecision({
    config,
    fullPrompt: prompt.fullPrompt,
    userPrompt: prompt.userPrompt,
    logPrefix: '[llm-router]',
    parseResponse: parseTradeDecisionResponse,
  });

  return result as TradeDecisionResult;
}

/**
 * Get a structured perpetual trade decision from the LLM.
 * Uses PerpTradeDecisionSchema.
 * Mirrors getTradeDecision with the same model-fallback and retry strategy.
 */
export async function getPerpTradeDecision(
  config: LLMRouterConfig,
  request: PerpTradeDecisionRequest,
): Promise<PerpTradeDecisionResult> {
  const prompt = buildPerpTradeDecisionPrompt(request);
  const result = await runStructuredDecision({
    config,
    fullPrompt: prompt.fullPrompt,
    userPrompt: prompt.userPrompt,
    logPrefix: '[llm-router:perp]',
    parseResponse: parsePerpTradeDecisionResponse,
  });

  return result as PerpTradeDecisionResult;
}

/**
 * List available free models from OpenRouter.
 * Cached in KV for 1 hour.
 */
export async function listFreeModels(
  apiKey: string,
  cache: KVNamespace,
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
    .filter((model) => parseFloat(model.pricing.prompt) === 0)
    .map((model) => ({ id: model.id, name: model.name, context: model.context_length }));

  try {
    await cache.put(cacheKey, JSON.stringify(freeModels), {
      expirationTtl: 86400,
    });
  } catch (err) {
    console.warn('[llm-router] free-model cache put failed:', err);
  }

  return freeModels;
}

async function runStructuredDecision<TParsed>(params: {
  config: LLMRouterConfig;
  fullPrompt: string;
  userPrompt: string;
  logPrefix: string;
  parseResponse: (text: string) => TParsed;
}): Promise<TParsed & LlmDecisionMetadata> {
  const { config, fullPrompt, userPrompt, logPrefix, parseResponse } = params;
  const startTime = Date.now();
  const timeoutMs = config.timeoutMs ?? DEFAULT_LLM_TIMEOUT_MS;
  const debugLogging = config.debugLogging === true;
  const { isAnthropic, resolveModel } = createModelResolver(config);
  const { modelsToTry, primaryModelSet } = buildModelsToTry(config, isAnthropic);

  let lastError: unknown;

  for (const modelId of modelsToTry) {
    const effectiveTimeout = primaryModelSet.has(modelId) ? timeoutMs : EMERGENCY_MODEL_TIMEOUT_MS;
    const maxModelRetries = primaryModelSet.has(modelId) ? 2 : 1;
    let modelAttempt = 0;

    while (modelAttempt <= maxModelRetries) {
      try {
        const timeoutPromise = new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error(`Model request timed out after ${effectiveTimeout / 1000}s`)),
            effectiveTimeout,
          ),
        );

        if (modelAttempt === 0) {
          console.log(`${logPrefix} Model:`, modelId);
          console.log(`${logPrefix} Prompt length (chars):`, fullPrompt.length);
          if (debugLogging) {
            console.log(`${logPrefix} === PROMPT SENT TO LLM ===`);
            console.log(userPrompt);
            console.log(`${logPrefix} === END PROMPT ===`);
          } else {
            console.log(`${logPrefix} User prompt preview:`);
            console.log(previewPromptForLogs(userPrompt));
          }
        } else {
          console.log(`${logPrefix} Retry ${modelAttempt}/${maxModelRetries} for model ${modelId}`);
        }

        const result = await Promise.race([
          generateText({
            model: resolveModel(modelId) as any,
            prompt: fullPrompt,
            ...(config.temperature !== undefined ? { temperature: config.temperature } : {}),
            maxRetries: 0,
          }),
          timeoutPromise,
        ]);

        const usage = (result as any).usage ?? {};
        const parsed = parseResponse(result.text ?? '');

        return {
          ...parsed,
          latencyMs: Date.now() - startTime,
          tokensUsed: usage.totalTokens,
          tokensIn: usage.inputTokens,
          tokensOut: usage.outputTokens,
          modelUsed: modelId,
          llmPromptText: fullPrompt,
          llmRawResponse: result.text ?? '',
        };
      } catch (err) {
        lastError = err;
        const transient = isTransientError(err);
        const classified = classifyLlmError(err, { model: modelId, attempt: modelAttempt });
        console.warn(
          `${logPrefix} model=${modelId} attempt=${modelAttempt} error_code=${classified.code} message=${classified.message}`,
        );

        if (transient && modelAttempt < maxModelRetries) {
          const backoffMs = 500 * Math.pow(2, modelAttempt);
          console.log(`${logPrefix} Transient error - retrying in ${backoffMs}ms`);
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
