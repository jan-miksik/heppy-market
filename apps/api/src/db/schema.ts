import { sql } from 'drizzle-orm';
import { text, real, integer, sqliteTable } from 'drizzle-orm/sqlite-core';

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  walletAddress: text('wallet_address').notNull().unique(),
  email: text('email'),
  displayName: text('display_name'),
  authProvider: text('auth_provider').notNull().default('wallet'),
  avatarUrl: text('avatar_url'),
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
  config: text('config').notNull(),
  llmModel: text('llm_model').notNull(),
  ownerAddress: text('owner_address'),
  managerId: text('manager_id'),
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
  marketDataSnapshot: text('market_data_snapshot').notNull(),
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
  createdAt: text('created_at')
    .notNull()
    .default(sql`(datetime('now'))`),
});
