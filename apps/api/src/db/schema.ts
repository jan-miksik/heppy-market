import { sql } from 'drizzle-orm';
import { text, real, integer, sqliteTable } from 'drizzle-orm/sqlite-core';

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  walletAddress: text('wallet_address').notNull().unique(),
  email: text('email'),
  displayName: text('display_name'),
  authProvider: text('auth_provider').notNull().default('wallet'),
  avatarUrl: text('avatar_url'),
  /** User role: 'user' (default) | 'tester' (can use Anthropic models via server ANTHROPIC_API_KEY) */
  role: text('role').notNull().default('user'),
  /** AES-GCM encrypted OpenRouter key. null = not connected; agents fall back to server OPENROUTER_API_KEY. */
  openRouterKey: text('openrouter_key'),
  createdAt: text('created_at')
    .notNull()
    .default(sql`(datetime('now'))`),
  updatedAt: text('updated_at')
    .notNull()
    .default(sql`(datetime('now'))`),
});

export const agents = sqliteTable('agents', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  status: text('status').notNull().default('stopped'),
  autonomyLevel: integer('autonomy_level').notNull(),
  chain: text('chain').notNull().default('base'),
  config: text('config').notNull(),
  llmModel: text('llm_model').notNull(),
  ownerAddress: text('owner_address'),
  managerId: text('manager_id'),
  personaMd: text('persona_md'),
  profileId: text('profile_id'),
  initiaWalletAddress: text('initia_wallet_address'),
  initiaMetadataHash: text('initia_metadata_hash'),
  initiaMetadataVersion: integer('initia_metadata_version'),
  initiaLinkTxHash: text('initia_link_tx_hash'),
  initiaLinkedAt: text('initia_linked_at'),
  initiaSyncState: text('initia_sync_state'),
  initiaLastSyncedAt: text('initia_last_synced_at'),
  createdAt: text('created_at')
    .notNull()
    .default(sql`(datetime('now'))`),
  updatedAt: text('updated_at')
    .notNull()
    .default(sql`(datetime('now'))`),
});

export const trades = sqliteTable('trades', {
  id: text('id').primaryKey(),
  agentId: text('agent_id')
    .notNull()
    .references(() => agents.id),
  pair: text('pair').notNull(),
  dex: text('dex').notNull(),
  side: text('side').notNull(),
  entryPrice: real('entry_price').notNull(),
  exitPrice: real('exit_price'),
  amountUsd: real('amount_usd').notNull(),
  pnlPct: real('pnl_pct'),
  pnlUsd: real('pnl_usd'),
  confidenceBefore: real('confidence_before').notNull(),
  confidenceAfter: real('confidence_after'),
  reasoning: text('reasoning').notNull(),
  strategyUsed: text('strategy_used').notNull(),
  slippageSimulated: real('slippage_simulated').notNull().default(0.003),
  status: text('status').notNull().default('open'),
  closeReason: text('close_reason'),
  openedAt: text('opened_at').notNull(),
  closedAt: text('closed_at'),
});

export const agentDecisions = sqliteTable('agent_decisions', {
  id: text('id').primaryKey(),
  agentId: text('agent_id').notNull(),
  decision: text('decision').notNull(),
  confidence: real('confidence').notNull(),
  reasoning: text('reasoning').notNull(),
  llmModel: text('llm_model').notNull(),
  llmLatencyMs: integer('llm_latency_ms').notNull(),
  llmTokensUsed: integer('llm_tokens_used'),
  llmPromptTokens: integer('llm_prompt_tokens'),
  llmCompletionTokens: integer('llm_completion_tokens'),
  marketDataSnapshot: text('market_data_snapshot').notNull(),
  llmPromptText: text('llm_prompt_text'),
  llmRawResponse: text('llm_raw_response'),
  createdAt: text('created_at').notNull(),
});

export const performanceSnapshots = sqliteTable('performance_snapshots', {
  id: text('id').primaryKey(),
  agentId: text('agent_id').notNull(),
  balance: real('balance').notNull(),
  totalPnlPct: real('total_pnl_pct').notNull(),
  winRate: real('win_rate').notNull(),
  totalTrades: integer('total_trades').notNull(),
  sharpeRatio: real('sharpe_ratio'),
  maxDrawdown: real('max_drawdown'),
  snapshotAt: text('snapshot_at').notNull(),
});

export const agentManagers = sqliteTable('agent_managers', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  ownerAddress: text('owner_address').notNull(),
  config: text('config').notNull(),
  status: text('status').notNull().default('stopped'),
  personaMd: text('persona_md'),
  profileId: text('profile_id'),
  createdAt: text('created_at')
    .notNull()
    .default(sql`(datetime('now'))`),
  updatedAt: text('updated_at')
    .notNull()
    .default(sql`(datetime('now'))`),
});

export const agentManagerLogs = sqliteTable('agent_manager_logs', {
  id: text('id').primaryKey(),
  managerId: text('manager_id')
    .notNull()
    .references(() => agentManagers.id),
  action: text('action').notNull(),
  reasoning: text('reasoning').notNull(),
  result: text('result').notNull(),
  llmPromptTokens: integer('llm_prompt_tokens'),
  llmCompletionTokens: integer('llm_completion_tokens'),
  createdAt: text('created_at')
    .notNull()
    .default(sql`(datetime('now'))`),
});

export const agentSelfModifications = sqliteTable('agent_self_modifications', {
  id:             text('id').primaryKey(),
  agentId:        text('agent_id').notNull(),
  decisionId:     text('decision_id').notNull(),
  reason:         text('reason').notNull(),
  changes:        text('changes').notNull(),
  changesApplied: text('changes_applied'),
  status:         text('status').notNull().default('pending'),
  appliedAt:      text('applied_at'),
  createdAt:      text('created_at').notNull(),
});

export const behaviorProfiles = sqliteTable('behavior_profiles', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  emoji: text('emoji').notNull().default('🤖'),
  description: text('description'),
  type: text('type').notNull(), // 'agent' | 'manager'
  behaviorConfig: text('behavior_config').notNull(),
  isPreset: integer('is_preset').notNull().default(0),
  createdAt: text('created_at')
    .notNull()
    .default(sql`(datetime('now'))`),
  updatedAt: text('updated_at')
    .notNull()
    .default(sql`(datetime('now'))`),
});
