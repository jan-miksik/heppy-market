import { z } from 'zod';

export const AgentConfigSchema = z.object({
  // Identity
  name: z.string().min(1).max(50),
  description: z.string().max(500).optional(),

  // Autonomy
  autonomyLevel: z.enum(['full', 'guided', 'strict']),

  // LLM
  llmModel: z.string().default('nvidia/nemotron-3-nano-30b-a3b:free'),
  llmFallback: z.string().default('nvidia/nemotron-3-nano-30b-a3b:free'),
  /** When true, if primary model fails we try the fallback model. No automatic fallbacks without consent. */
  allowFallback: z.boolean().default(false),
  maxLlmCallsPerHour: z.number().min(1).max(60).default(12),
  temperature: z.number().min(0).max(2).default(0.7),

  // Trading
  chain: z.literal('base').default('base'),
  dexes: z
    .array(z.enum(['aerodrome', 'uniswap-v3']))
    .default(['aerodrome', 'uniswap-v3']),
  pairs: z
    .array(z.string())
    .min(1)
    .max(10)
    .default(['WETH/USDC', 'cbBTC/WETH', 'AERO/USDC']),
  paperBalance: z.number().min(100).max(1_000_000).default(10_000),
  maxPositionSizePct: z.number().min(1).max(100).default(5),
  maxOpenPositions: z.number().min(1).max(10).default(3),
  stopLossPct: z.number().min(0.5).max(50).default(5),
  takeProfitPct: z.number().min(0.5).max(100).default(7),
  slippageSimulation: z.number().min(0).max(5).default(0.3),

  // Timeframe
  analysisInterval: z
    .enum(['1m', '5m', '15m', '1h', '4h', '1d'])
    .default('15m'),

  // Strategies
  strategies: z
    .array(
      z.enum([
        'ema_crossover',
        'rsi_oversold',
        'macd_signal',
        'bollinger_bounce',
        'volume_breakout',
        'llm_sentiment',
        'combined',
      ])
    )
    .default(['combined']),

  // Risk
  maxDailyLossPct: z.number().min(1).max(50).default(10),
  cooldownAfterLossMinutes: z.number().min(0).max(1440).default(30),
});

export type AgentConfigInput = z.input<typeof AgentConfigSchema>;
export type AgentConfigOutput = z.output<typeof AgentConfigSchema>;

export const TradeDecisionSchema = z.object({
  action: z.enum(['buy', 'sell', 'hold', 'close']),
  confidence: z.number().min(0).max(1),
  reasoning: z.string(),
  targetPair: z.string().optional(),
  suggestedPositionSizePct: z.number().min(0).max(100).optional(),
});

export const CreateAgentRequestSchema = z.object({
  name: z.string().min(1).max(50),
  description: z.string().max(500).optional(),
  autonomyLevel: z.enum(['full', 'guided', 'strict']).default('guided'),
  llmModel: z.string().default('nvidia/nemotron-3-nano-30b-a3b:free'),
  llmFallback: z.string().default('nvidia/nemotron-3-nano-30b-a3b:free'),
  allowFallback: z.boolean().default(false),
  maxLlmCallsPerHour: z.number().min(1).max(60).default(12),
  temperature: z.number().min(0).max(2).default(0.7),
  chain: z.literal('base').default('base'),
  dexes: z
    .array(z.enum(['aerodrome', 'uniswap-v3']))
    .default(['aerodrome', 'uniswap-v3']),
  pairs: z
    .array(z.string())
    .min(1)
    .max(10)
    .default(['WETH/USDC', 'cbBTC/WETH', 'AERO/USDC']),
  paperBalance: z.number().min(100).max(1_000_000).default(10_000),
  maxPositionSizePct: z.number().min(1).max(100).default(5),
  maxOpenPositions: z.number().min(1).max(10).default(3),
  stopLossPct: z.number().min(0.5).max(50).default(5),
  takeProfitPct: z.number().min(0.5).max(100).default(7),
  slippageSimulation: z.number().min(0).max(5).default(0.3),
  analysisInterval: z
    .enum(['1m', '5m', '15m', '1h', '4h', '1d'])
    .default('15m'),
  strategies: z
    .array(
      z.enum([
        'ema_crossover',
        'rsi_oversold',
        'macd_signal',
        'bollinger_bounce',
        'volume_breakout',
        'llm_sentiment',
        'combined',
      ])
    )
    .default(['combined']),
  maxDailyLossPct: z.number().min(1).max(50).default(10),
  cooldownAfterLossMinutes: z.number().min(0).max(1440).default(30),
});

export const UpdateAgentRequestSchema = CreateAgentRequestSchema.partial();
