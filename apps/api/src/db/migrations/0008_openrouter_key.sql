-- Migration: 0008_openrouter_key
-- Store encrypted OpenRouter API key per user (null = not connected, uses server fallback key)
ALTER TABLE users ADD COLUMN openrouter_key TEXT;
