/** Agent autonomy levels */
export type AutonomyLevel = 'full' | 'guided' | 'strict';

/** Supported chains */
export type Chain = 'base';

/** Supported DEXes */
export type Dex = 'aerodrome' | 'uniswap-v3';

/** Analysis intervals */
export type AnalysisInterval = '1m' | '5m' | '15m' | '1h' | '4h' | '1d';

/** Trading strategies */
export type Strategy =
  | 'ema_crossover'
  | 'rsi_oversold'
  | 'macd_signal'
  | 'bollinger_bounce'
  | 'volume_breakout'
  | 'llm_sentiment'
  | 'combined';

/** Trade side */
export type TradeSide = 'buy' | 'sell';

/** Trade status */
export type TradeStatus = 'open' | 'closed' | 'stopped_out';

/** Agent status */
export type AgentStatus = 'running' | 'stopped' | 'paused';

/** Trade decision from LLM */
export type TradeAction = 'buy' | 'sell' | 'hold' | 'close';

/** Agent configuration */
export interface AgentConfig {
  name: string;
  description?: string;
  autonomyLevel: AutonomyLevel;
  llmModel: string;
  llmFallback: string;
  maxLlmCallsPerHour: number;
  chain: Chain;
  dexes: Dex[];
  pairs: string[];
  paperBalance: number;
  maxPositionSizePct: number;
  maxOpenPositions: number;
  stopLossPct: number;
  takeProfitPct: number;
  slippageSimulation: number;
  analysisInterval: AnalysisInterval;
  strategies: Strategy[];
  maxDailyLossPct: number;
  cooldownAfterLossMinutes: number;
}

/** Trade record */
export interface Trade {
  id: string;
  agentId: string;
  pair: string;
  dex: string;
  side: TradeSide;
  entryPrice: number;
  exitPrice?: number;
  amountUsd: number;
  pnlPct?: number;
  pnlUsd?: number;
  confidenceBefore: number;
  confidenceAfter?: number;
  reasoning: string;
  strategyUsed: string;
  slippageSimulated: number;
  status: TradeStatus;
  openedAt: string;
  closedAt?: string;
}

/** Agent decision record */
export interface AgentDecision {
  id: string;
  agentId: string;
  decision: TradeAction;
  confidence: number;
  reasoning: string;
  llmModel: string;
  llmLatencyMs: number;
  llmTokensUsed?: number;
  marketDataSnapshot: string;
  createdAt: string;
}

/** Performance snapshot */
export interface PerformanceSnapshot {
  id: string;
  agentId: string;
  balance: number;
  totalPnlPct: number;
  winRate: number;
  totalTrades: number;
  sharpeRatio?: number;
  maxDrawdown?: number;
  snapshotAt: string;
}

/** Trade decision from LLM */
export interface TradeDecision {
  action: TradeAction;
  confidence: number;
  reasoning: string;
  targetPair?: string;
  suggestedPositionSizePct?: number;
}
