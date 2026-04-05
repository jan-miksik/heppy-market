import { z } from 'zod';
import { DEFAULT_FREE_AGENT_MODEL } from './model-catalog.js';
import { TRADING_INTERVALS } from './intervals.js';

const CHAIN_SCHEMA = z.enum(['base', 'initia']);

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

export const ENTITY_NAME_MAX_CHARS = 256;

const EntityNameSchema = z
  .string()
  .min(1, 'Name is required')
  .max(ENTITY_NAME_MAX_CHARS, `Name must be at most ${ENTITY_NAME_MAX_CHARS} characters`);

export const AgentConfigSchema = z.object({
  // Identity
  name: EntityNameSchema,
  description: z.string().max(500).optional(),

  // LLM
  llmModel: z.string().default(DEFAULT_FREE_AGENT_MODEL),
  llmFallback: z.string().default(DEFAULT_FREE_AGENT_MODEL),
  /** When true, if primary model fails we try the fallback model. No automatic fallbacks without consent. */
  allowFallback: z.boolean().default(false),
  maxLlmCallsPerHour: z.number().min(1).max(60).default(12),
  temperature: z.number().min(0).max(2).default(0.7),

  // Trading
  chain: CHAIN_SCHEMA.default('base'),
  dexes: z
    .array(z.enum(['aerodrome', 'uniswap-v3']))
    .default(['aerodrome', 'uniswap-v3']),
  pairs: z
    .array(z.string())
    .min(1)
    .max(10)
    .default(['WETH/USDC', 'cbBTC/WETH', 'AERO/USDC']),
  paperBalance: z.number().min(0).max(1_000_000).default(10_000),
  maxPositionSizePct: z.number().min(1).max(100).default(5),
  maxOpenPositions: z.number().min(1).max(10).default(3),
  stopLossPct: z.number().min(0.5).max(50).default(5),
  takeProfitPct: z.number().min(0.5).max(100).default(7),
  slippageSimulation: z.number().min(0).max(5).default(0.3),

  // Timeframe
  analysisInterval: z.enum(TRADING_INTERVALS).default('1h'),

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

  // Initia extension metadata (optional)
  initiaWalletAddress: z.string().trim().min(3).max(128).optional(),
  initiaMetadataHash: z.string().trim().min(8).max(256).optional(),
  initiaMetadataVersion: z.number().int().min(1).max(10_000).optional(),

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
  name: EntityNameSchema,
  description: z.string().max(500).optional(),
  llmModel: z.string().default(DEFAULT_FREE_AGENT_MODEL),
  llmFallback: z.string().default(DEFAULT_FREE_AGENT_MODEL),
  allowFallback: z.boolean().default(false),
  maxLlmCallsPerHour: z.number().min(1).max(60).default(12),
  temperature: z.number().min(0).max(2).default(0.7),
  chain: CHAIN_SCHEMA.default('base'),
  dexes: z
    .array(z.enum(['aerodrome', 'uniswap-v3']))
    .default(['aerodrome', 'uniswap-v3']),
  pairs: z
    .array(z.string())
    .min(1)
    .max(10)
    .default(['WETH/USDC', 'cbBTC/WETH', 'AERO/USDC']),
  paperBalance: z.number().min(0).max(1_000_000).default(10_000),
  maxPositionSizePct: z.number().min(1).max(100).default(5),
  maxOpenPositions: z.number().min(1).max(10).default(3),
  stopLossPct: z.number().min(0.5).max(50).default(5),
  takeProfitPct: z.number().min(0.5).max(100).default(7),
  slippageSimulation: z.number().min(0).max(5).default(0.3),
  analysisInterval: z.enum(TRADING_INTERVALS).default('1h'),
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

  // Initia extension metadata (optional)
  initiaWalletAddress: z.string().trim().min(3).max(128).optional(),
  initiaMetadataHash: z.string().trim().min(8).max(256).optional(),
  initiaMetadataVersion: z.number().int().min(1).max(10_000).optional(),

  // Behavior (optional — falls back to defaults / profile)
  behavior: AgentBehaviorConfigSchema.optional(),
  profileId: z.string().optional(),
  personaMd: z.string().max(4000).optional(),
  behaviorMd: z.string().max(4000).optional(),
  roleMd: z.string().max(4000).optional(),
});

export const UpdateAgentRequestSchema = CreateAgentRequestSchema.partial();

export const InitiaMetadataPointerSchema = z.object({
  agentId: z.string().min(1).max(128),
  version: z.number().int().min(1).max(10_000),
  configHash: z.string().min(8).max(256),
  labels: z.record(z.string(), z.string()).optional(),
});

export const InitiaLinkRequestSchema = z.object({
  initiaWalletAddress: z.string().trim().min(3).max(128),
  evmAddress: z.string().trim().min(3).max(128).optional(),
  txHash: z.string().trim().min(6).max(128),
  metadataPointer: InitiaMetadataPointerSchema,
});

export const InitiaSyncStateSchema = z.object({
  walletAddress: z.string().trim().min(3).max(128).optional(),
  evmAddress: z.string().trim().min(3).max(128).optional(),
  onchainAgentId: z.string().trim().min(1).max(64).optional(),
  chainOk: z.boolean().optional(),
  existsOnchain: z.boolean().optional(),
  autoSignEnabled: z.boolean().optional(),
  executorAuthorized: z.boolean().optional(),
  walletBalanceWei: z.string().trim().min(1).max(128).optional(),
  vaultBalanceWei: z.string().trim().min(1).max(128).optional(),
  walletShowcaseTokenBalanceWei: z.string().trim().min(1).max(128).optional(),
  showcaseTokenBalanceWei: z.string().trim().min(1).max(128).optional(),
  contractAddress: z.string().trim().min(1).max(128).optional(),
  lastTxHash: z.string().trim().min(6).max(128).optional(),
  syncTrigger: z.string().trim().min(1).max(64).optional(),
  error: z.string().trim().min(1).max(512).optional(),
});

export const InitiaSyncRequestSchema = z.object({
  state: InitiaSyncStateSchema,
});

export const ManagerRiskParamsSchema = z.object({
  maxTotalDrawdown: z.number().min(0.01).max(1).default(0.2),
  maxAgents: z.number().min(1).max(20).default(3),
  maxCorrelatedPositions: z.number().min(1).max(10).default(3),
});

export const ManagerConfigSchema = z.object({
  llmModel: z.string().default(DEFAULT_FREE_AGENT_MODEL),
  temperature: z.number().min(0).max(2).default(0.7),
  decisionInterval: z.enum(TRADING_INTERVALS).default('1h'),
  riskParams: ManagerRiskParamsSchema.default({}),

  // Behavior (optional — falls back to defaults / profile)
  behavior: ManagerBehaviorConfigSchema.optional(),
  profileId: z.string().optional(),
});

export type ManagerConfig = z.infer<typeof ManagerConfigSchema>;

export const CreateManagerRequestSchema = z.object({
  name: EntityNameSchema,
  description: z.string().max(500).optional(),
  llmModel: z.string().default(DEFAULT_FREE_AGENT_MODEL),
  temperature: z.number().min(0).max(2).default(0.7),
  decisionInterval: z.enum(TRADING_INTERVALS).default('1h'),
  riskParams: ManagerRiskParamsSchema.optional(),

  // Behavior (optional — falls back to defaults / profile)
  behavior: ManagerBehaviorConfigSchema.optional(),
  profileId: z.string().optional(),
  personaMd: z.string().max(4000).optional(),
});

export const UpdateManagerRequestSchema = CreateManagerRequestSchema.partial();

export const CreateBehaviorProfileSchema = z.object({
  name: EntityNameSchema,
  emoji: z.string().default('🤖'),
  description: z.string().max(500).optional(),
  type: z.enum(['agent', 'manager']),
  behaviorConfig: z.union([AgentBehaviorConfigSchema, ManagerBehaviorConfigSchema]),
});

export const UpdatePersonaSchema = z.object({
  personaMd: z.string().max(4000),
});
