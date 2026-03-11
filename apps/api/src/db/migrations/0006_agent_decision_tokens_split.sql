-- Migration: 0006_agent_decision_tokens_split

ALTER TABLE agent_decisions ADD COLUMN llm_prompt_tokens INTEGER;
ALTER TABLE agent_decisions ADD COLUMN llm_completion_tokens INTEGER;
