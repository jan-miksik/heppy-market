import { z } from 'zod';

// ─── Behavior Config ────────────────────────────────────────────────────────

export const AgentBehaviorConfigSchema = z.object({
  // Risk Personality
  riskAppetite: z.enum(['conservative', 'moderate', 'aggressive', 'degen']).default('moderate'),
  fomoProne: z.number().min(0).max(100).default(30),
  panicSellThreshold: z.number().min(0).max(100).default(50),
  contrarian: z.number().min(0).max(100).default(20),

  // Decision Style
  analysisDepth: z.enum(['quick', 'balanced', 'thorough']).default('balanced'),
  decisionSpeed: z.enum(['impulsive', 'measured', 'patient']).default('measured'),
  confidenceThreshold: z.number().min(0).max(100).default(60),
  overthinker: z.boolean().default(false),

  // Trading Philosophy
  style: z.enum(['scalper', 'swing', 'position', 'hybrid']).default('swing'),
  preferredConditions: z.enum(['trending', 'ranging', 'volatile', 'any']).default('any'),
  entryPreference: z.enum(['breakout', 'pullback', 'dip_buy', 'momentum']).default('momentum'),
  exitStrategy: z.enum(['tight_stops', 'trailing', 'time_based', 'signal_based']).default('signal_based'),
  averageDown: z.boolean().default(false),

  // Communication & Logging
  verbosity: z.enum(['minimal', 'normal', 'detailed', 'stream_of_consciousness']).default('normal'),
  personality: z.enum(['professional', 'casual', 'meme_lord', 'academic', 'custom']).default('professional'),
  emotionalAwareness: z.boolean().default(false),

  // Market Outlook
  defaultBias: z.enum(['bullish', 'bearish', 'neutral']).default('neutral'),
  adaptability: z.number().min(0).max(100).default(50),
  memoryWeight: z.enum(['short', 'medium', 'long']).default('medium'),
});

export type AgentBehaviorConfig = z.infer<typeof AgentBehaviorConfigSchema>;

export const ManagerBehaviorConfigSchema = z.object({
  managementStyle: z.enum(['hands_off', 'balanced', 'micromanager']).default('balanced'),
  riskTolerance: z.enum(['conservative', 'moderate', 'aggressive']).default('moderate'),
  diversificationPreference: z.enum(['concentrated', 'balanced', 'diversified']).default('balanced'),
  performancePatience: z.number().min(0).max(100).default(50),
  creationAggressiveness: z.number().min(0).max(100).default(50),
  rebalanceFrequency: z.enum(['rarely', 'sometimes', 'often']).default('sometimes'),
  philosophyBias: z.enum(['trend_following', 'mean_reversion', 'mixed']).default('mixed'),
});

export type ManagerBehaviorConfig = z.infer<typeof ManagerBehaviorConfigSchema>;

export const AgentConfigSchema = z.object({
  // Identity
  name: z.string().min(1).max(50),
  description: z.string().max(500).optional(),

  // LLM
  llmModel: z.string().default('nvidia/nemotron-3-super-120b-a12b:free'),
  llmFallback: z.string().default('nvidia/nemotron-3-super-120b-a12b:free'),
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
    .enum(['15m', '1h', '4h', '1d'])
    .default('1h'),

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

  // Behavior (optional — falls back to defaults / profile)
  behavior: AgentBehaviorConfigSchema.optional(),
  profileId: z.string().optional(),
  behaviorMd: z.string().max(4000).optional(),
  roleMd: z.string().max(4000).optional(),
});

export type AgentConfigInput = z.input<typeof AgentConfigSchema>;
export type AgentConfigOutput = z.output<typeof AgentConfigSchema>;

export const TradeDecisionSchema = z.object({
  action: z.enum(['buy', 'sell', 'hold', 'close']),
  confidence: z.number().min(0).max(1),
  reasoning: z.string(),
  targetPair: z.string().nullable().optional(),
  suggestedPositionSizePct: z.number().min(0).max(100).nullable().optional(),
});

export const CreateAgentRequestSchema = z.object({
  name: z.string().min(1).max(50),
  description: z.string().max(500).optional(),
  llmModel: z.string().default('nvidia/nemotron-3-super-120b-a12b:free'),
  llmFallback: z.string().default('nvidia/nemotron-3-super-120b-a12b:free'),
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
    .enum(['15m', '1h', '4h', '1d'])
    .default('1h'),
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

  // Behavior (optional — falls back to defaults / profile)
  behavior: AgentBehaviorConfigSchema.optional(),
  profileId: z.string().optional(),
  personaMd: z.string().max(4000).optional(),
  behaviorMd: z.string().max(4000).optional(),
  roleMd: z.string().max(4000).optional(),
});

export const UpdateAgentRequestSchema = CreateAgentRequestSchema.partial();

export const ManagerRiskParamsSchema = z.object({
  maxTotalDrawdown: z.number().min(0.01).max(1).default(0.2),
  maxAgents: z.number().min(1).max(20).default(3),
  maxCorrelatedPositions: z.number().min(1).max(10).default(3),
});

const FREE_MANAGER_MODELS = [
  'nvidia/nemotron-3-super-120b-a12b:free',
  'nvidia/nemotron-3-nano-30b-a3b:free',
  'stepfun/step-3.5-flash:free',
  'nvidia/nemotron-nano-9b-v2:free',
  'arcee-ai/trinity-large-preview:free',
  'xiaomi/mimo-v2-flash:free',
] as const;

export const ManagerConfigSchema = z.object({
  llmModel: z.string().default('nvidia/nemotron-3-super-120b-a12b:free'),
  temperature: z.number().min(0).max(2).default(0.7),
  decisionInterval: z.enum(['1h', '4h', '1d']).default('1h'),
  riskParams: ManagerRiskParamsSchema.default({}),

  // Behavior (optional — falls back to defaults / profile)
  behavior: ManagerBehaviorConfigSchema.optional(),
  profileId: z.string().optional(),
});

export type ManagerConfig = z.infer<typeof ManagerConfigSchema>;

export const CreateManagerRequestSchema = z.object({
  name: z.string().min(1).max(50),
  description: z.string().max(500).optional(),
  llmModel: z.string().default('nvidia/nemotron-3-super-120b-a12b:free'),
  temperature: z.number().min(0).max(2).default(0.7),
  decisionInterval: z.enum(['1h', '4h', '1d']).default('1h'),
  riskParams: ManagerRiskParamsSchema.optional(),

  // Behavior (optional — falls back to defaults / profile)
  behavior: ManagerBehaviorConfigSchema.optional(),
  profileId: z.string().optional(),
});

export const UpdateManagerRequestSchema = CreateManagerRequestSchema.partial();

export const CreateBehaviorProfileSchema = z.object({
  name: z.string().min(1).max(50),
  emoji: z.string().default('🤖'),
  description: z.string().max(500).optional(),
  type: z.enum(['agent', 'manager']),
  behaviorConfig: z.union([AgentBehaviorConfigSchema, ManagerBehaviorConfigSchema]),
});

export const UpdatePersonaSchema = z.object({
  personaMd: z.string().max(4000),
});
