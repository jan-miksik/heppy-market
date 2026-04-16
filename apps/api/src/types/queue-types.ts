import type { LLMRouterConfig, TradeDecisionRequest } from '../services/llm-router.js';

/**
 * LLM config fields that are safe to include in a queue message (no secrets).
 * The consumer re-resolves apiKey at processing time using ownerAddress + D1.
 */
export type LlmJobConfig = Omit<LLMRouterConfig, 'apiKey'> & {
  /** Wallet address of the agent owner — used to look up the decrypted API key in D1. */
  ownerAddress: string;
};

/** Message enqueued by TradingAgentDO for async LLM processing. */
export type LlmJobMessage = {
  /** DO name key (same as agentId). */
  agentId: string;
  /** Unique job ID — DO uses this to reject stale or duplicate deliveries. */
  jobId: string;
  /** LLM config — apiKey is intentionally excluded; consumer resolves it from D1. */
  llmConfig: LlmJobConfig;
  /** Full trade context built from market data fetch this tick. */
  tradeRequest: TradeDecisionRequest;
};
