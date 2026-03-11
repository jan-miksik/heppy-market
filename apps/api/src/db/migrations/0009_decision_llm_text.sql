-- Add full LLM prompt and raw response storage to agent_decisions
ALTER TABLE agent_decisions ADD COLUMN llm_prompt_text TEXT;
ALTER TABLE agent_decisions ADD COLUMN llm_raw_response TEXT;
