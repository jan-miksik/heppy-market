import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { classifyLlmError } from '../../lib/agent-errors.js';
import type { LLMRouterConfig } from './types.js';

export const DEFAULT_LLM_TIMEOUT_MS = 90_000;
export const EMERGENCY_MODEL_TIMEOUT_MS = 30_000;
export const EMERGENCY_FREE_MODELS = [
  'qwen/qwen3-coder:free',
  'arcee-ai/trinity-large-preview:free',
  'google/gemma-3-27b-it:free',
  'google/gemma-3-12b-it:free',
  'google/gemma-3-4b-it:free',
];

export function createModelResolver(config: LLMRouterConfig): {
  isAnthropic: boolean;
  resolveModel(modelId: string): unknown;
} {
  const isAnthropic = config.provider === 'anthropic';
  const openrouter = isAnthropic ? null : createOpenRouter({ apiKey: config.apiKey });
  const anthropic = isAnthropic ? createAnthropic({ apiKey: config.apiKey }) : null;

  return {
    isAnthropic,
    resolveModel(modelId: string): unknown {
      return isAnthropic ? anthropic!(modelId) : openrouter!(modelId);
    },
  };
}

export function buildModelsToTry(config: LLMRouterConfig, isAnthropic: boolean): {
  modelsToTry: string[];
  primaryModelSet: Set<string>;
} {
  const primaryModels: string[] = [config.model];
  if (config.allowFallback && config.fallbackModel && config.fallbackModel !== config.model) {
    primaryModels.push(config.fallbackModel);
  }

  const emergencyModels: string[] = [];
  if (config.allowFallback && !isAnthropic) {
    for (const modelId of EMERGENCY_FREE_MODELS) {
      if (!primaryModels.includes(modelId)) emergencyModels.push(modelId);
    }
  }

  return {
    modelsToTry: [...primaryModels, ...emergencyModels],
    primaryModelSet: new Set(primaryModels),
  };
}

export function isTransientError(err: unknown): boolean {
  const classified = classifyLlmError(err);
  return classified.code === 'LLM_TIMEOUT' ||
    classified.code === 'LLM_RATE_LIMIT' ||
    classified.code === 'LLM_NETWORK_ERROR';
}
