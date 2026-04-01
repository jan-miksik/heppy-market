-- Migration: 0012_initia_extension
-- Add Initia extension fields to agents table.

ALTER TABLE agents ADD COLUMN chain TEXT NOT NULL DEFAULT 'base';
ALTER TABLE agents ADD COLUMN initia_wallet_address TEXT;
ALTER TABLE agents ADD COLUMN initia_metadata_hash TEXT;
ALTER TABLE agents ADD COLUMN initia_metadata_version INTEGER;
ALTER TABLE agents ADD COLUMN initia_link_tx_hash TEXT;
ALTER TABLE agents ADD COLUMN initia_linked_at TEXT;
ALTER TABLE agents ADD COLUMN initia_sync_state TEXT;
ALTER TABLE agents ADD COLUMN initia_last_synced_at TEXT;

CREATE INDEX IF NOT EXISTS idx_agents_chain ON agents(chain);
CREATE INDEX IF NOT EXISTS idx_agents_initia_wallet ON agents(initia_wallet_address);

-- One Initia agent per Initia wallet (for hackathon phase).
CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_initia_wallet_unique
  ON agents(initia_wallet_address)
  WHERE chain = 'initia' AND initia_wallet_address IS NOT NULL;
