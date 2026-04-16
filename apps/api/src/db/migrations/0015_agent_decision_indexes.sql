-- Add indexes on agentId columns used in common WHERE clauses.
-- FK constraints are defined in schema.ts (Drizzle); D1 enforces them when
-- PRAGMA foreign_keys = ON. The indexes below are the primary runtime benefit.

CREATE INDEX IF NOT EXISTS idx_agent_decisions_agent_id ON agent_decisions (agent_id);
CREATE INDEX IF NOT EXISTS idx_performance_snapshots_agent_id ON performance_snapshots (agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_self_modifications_agent_id ON agent_self_modifications (agent_id);
