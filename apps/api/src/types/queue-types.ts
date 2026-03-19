import type { LLMRouterConfig, TradeDecisionRequest } from '../services/llm-router.js';

/** Message enqueued by TradingAgentDO for async LLM processing. */
export type LlmJobMessage = {
  /** DO name key (same as agentId). */
  agentId: string;
  /** Unique job ID — DO uses this to reject stale or duplicate deliveries. */
  jobId: string;
  /** Full LLM router config including the resolved (decrypted) apiKey. */
  llmConfig: LLMRouterConfig;
  /** Full trade context built from market data fetch this tick. */
  tradeRequest: TradeDecisionRequest;
};
