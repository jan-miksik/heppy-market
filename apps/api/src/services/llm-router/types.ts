import type { AgentBehaviorConfig, PerpTradeDecision, TradeDecision } from '@something-in-loop/shared';

/** When true, if the primary model fails we try the user-configured fallback model. No automatic emergency fallbacks. */
export interface LLMRouterConfig {
  apiKey: string;
  model: string;
  fallbackModel?: string;
  allowFallback?: boolean;
  maxRetries?: number;
  temperature?: number;
  timeoutMs?: number;
  provider?: 'openrouter' | 'anthropic';
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

export type LlmDecisionMetadata = {
  latencyMs: number;
  tokensUsed?: number;
  tokensIn?: number;
  tokensOut?: number;
  modelUsed: string;
  llmPromptText: string;
  llmRawResponse: string;
};

export type TradeDecisionResult = TradeDecision & LlmDecisionMetadata;
export type PerpTradeDecisionResult = PerpTradeDecision & LlmDecisionMetadata;
