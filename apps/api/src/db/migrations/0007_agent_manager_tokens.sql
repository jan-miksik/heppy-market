-- Migration: 0007_agent_manager_tokens

ALTER TABLE agent_manager_logs ADD COLUMN llm_prompt_tokens INTEGER;
ALTER TABLE agent_manager_logs ADD COLUMN llm_completion_tokens INTEGER;
