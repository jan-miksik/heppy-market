-- Migration: 0013_allow_multiple_initia_agents_per_wallet
-- Remove the hackathon-era uniqueness constraint so one wallet can own multiple Initia agents.

DROP INDEX IF EXISTS idx_agents_initia_wallet_unique;
