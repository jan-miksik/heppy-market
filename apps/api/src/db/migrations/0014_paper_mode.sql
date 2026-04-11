-- Migration: 0014_paper_mode
-- Explicit paper trading mode: agents with is_paper=1 never attempt on-chain execution.
ALTER TABLE agents ADD COLUMN is_paper INTEGER NOT NULL DEFAULT 0;
