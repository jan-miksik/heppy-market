-- Migration: 0005_user_role
-- Add role column to users table ('user' default, 'tester' grants access to Anthropic models)

ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user';
