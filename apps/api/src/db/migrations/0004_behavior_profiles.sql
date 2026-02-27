-- Migration: 0004_behavior_profiles

-- Add behavior/persona columns to agents
ALTER TABLE agents ADD COLUMN persona_md TEXT;
ALTER TABLE agents ADD COLUMN profile_id TEXT;

-- Add behavior/persona columns to managers
ALTER TABLE agent_managers ADD COLUMN persona_md TEXT;
ALTER TABLE agent_managers ADD COLUMN profile_id TEXT;

-- New table for custom behavior profiles
CREATE TABLE IF NOT EXISTS behavior_profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  emoji TEXT NOT NULL DEFAULT '🤖',
  description TEXT,
  type TEXT NOT NULL CHECK (type IN ('agent', 'manager')),
  behavior_config TEXT NOT NULL,
  is_preset INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_behavior_profiles_type ON behavior_profiles(type);
