-- Migration: 0001_initial
-- DEX Paper Trading Agents — initial schema

CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'stopped',
  autonomy_level INTEGER NOT NULL,
  config TEXT NOT NULL,
  llm_model TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS trades (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  pair TEXT NOT NULL,
  dex TEXT NOT NULL,
  side TEXT NOT NULL,
  entry_price REAL NOT NULL,
  exit_price REAL,
  amount_usd REAL NOT NULL,
  pnl_pct REAL,
  pnl_usd REAL,
  confidence_before REAL NOT NULL,
  confidence_after REAL,
  reasoning TEXT NOT NULL,
  strategy_used TEXT NOT NULL,
  slippage_simulated REAL NOT NULL DEFAULT 0.003,
  status TEXT NOT NULL DEFAULT 'open',
  opened_at TEXT NOT NULL,
  closed_at TEXT
);

CREATE TABLE IF NOT EXISTS agent_decisions (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  decision TEXT NOT NULL,
  confidence REAL NOT NULL,
  reasoning TEXT NOT NULL,
  llm_model TEXT NOT NULL,
  llm_latency_ms INTEGER NOT NULL,
  llm_tokens_used INTEGER,
  market_data_snapshot TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS performance_snapshots (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  balance REAL NOT NULL,
  total_pnl_pct REAL NOT NULL,
  win_rate REAL NOT NULL,
  total_trades INTEGER NOT NULL,
  sharpe_ratio REAL,
  max_drawdown REAL,
  snapshot_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_trades_agent_id ON trades(agent_id);
CREATE INDEX IF NOT EXISTS idx_trades_status ON trades(status);
CREATE INDEX IF NOT EXISTS idx_trades_opened_at ON trades(opened_at DESC);
CREATE INDEX IF NOT EXISTS idx_decisions_agent_id ON agent_decisions(agent_id);
CREATE INDEX IF NOT EXISTS idx_decisions_created_at ON agent_decisions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_snapshots_agent_id ON performance_snapshots(agent_id);
