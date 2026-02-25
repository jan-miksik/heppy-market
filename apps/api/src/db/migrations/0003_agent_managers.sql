-- Migration: 0003_agent_managers

CREATE TABLE IF NOT EXISTS agent_managers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  owner_address TEXT NOT NULL,
  config TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'stopped',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS agent_manager_logs (
  id TEXT PRIMARY KEY,
  manager_id TEXT NOT NULL REFERENCES agent_managers(id),
  action TEXT NOT NULL,
  reasoning TEXT NOT NULL,
  result TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_agent_manager_logs_manager_id ON agent_manager_logs(manager_id);

ALTER TABLE agents ADD COLUMN manager_id TEXT REFERENCES agent_managers(id);

CREATE INDEX IF NOT EXISTS idx_agents_manager_id ON agents(manager_id);
