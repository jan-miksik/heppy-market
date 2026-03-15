CREATE TABLE IF NOT EXISTS agent_self_modifications (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  decision_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  changes TEXT NOT NULL,
  changes_applied TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  applied_at TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_self_mods_agent_id ON agent_self_modifications(agent_id);
CREATE INDEX IF NOT EXISTS idx_self_mods_status ON agent_self_modifications(status);
