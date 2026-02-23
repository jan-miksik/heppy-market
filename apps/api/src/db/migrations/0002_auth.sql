-- Migration: 0002_auth
-- Add users table for wallet + social auth profiles
-- Add owner_address column to agents table

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  wallet_address TEXT UNIQUE NOT NULL,
  email TEXT,
  display_name TEXT,
  auth_provider TEXT NOT NULL DEFAULT 'wallet',
  avatar_url TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

ALTER TABLE agents ADD COLUMN owner_address TEXT;

CREATE INDEX IF NOT EXISTS idx_users_wallet ON users(wallet_address);
CREATE INDEX IF NOT EXISTS idx_agents_owner ON agents(owner_address);
