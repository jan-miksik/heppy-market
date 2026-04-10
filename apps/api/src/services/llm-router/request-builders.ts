import { buildJsonSchemaInstruction } from '@something-in-loop/shared';
import { BASE_AGENT_PROMPT, buildAnalysisPrompt, buildPerpAnalysisPrompt } from '../../agents/prompts.js';
import type { PerpTradeDecisionRequest, TradeDecisionRequest } from './types.js';

const LLM_LOG_PROMPT_PREVIEW_MAX_CHARS = 800;

export function buildPerpJsonSchemaInstruction(): string {
  return `
IMPORTANT: Respond with ONLY a valid JSON object - no markdown, no code blocks, no explanation.
The JSON must match this schema exactly:
{
  "action": "OPEN_LONG" | "OPEN_SHORT" | "CLOSE_LONG" | "CLOSE_SHORT" | "HOLD",
  "market": "<string - e.g. BTC/USD>",
  "confidence": <number 0.0-1.0>,
  "sizePct": <number 0-100 - % of balance to use for OPEN actions; 0 for CLOSE/HOLD>,
  "maxSlippageBps": <integer 0-10000 - acceptable slippage in basis points>,
  "rationale": "<string - 1-2 sentence explanation>"
}
Do NOT include calldata, token addresses, function selectors, or deadlines - the backend generates those.`;
}

export function previewPromptForLogs(text: string): string {
  if (text.length <= LLM_LOG_PROMPT_PREVIEW_MAX_CHARS) return text;
  return `${text.slice(0, LLM_LOG_PROMPT_PREVIEW_MAX_CHARS)}\n...[truncated ${text.length - LLM_LOG_PROMPT_PREVIEW_MAX_CHARS} chars]`;
}

export function buildTradeDecisionPrompt(request: TradeDecisionRequest): {
  userPrompt: string;
  fullPrompt: string;
} {
  const systemPrompt = BASE_AGENT_PROMPT + buildJsonSchemaInstruction();
  const userPrompt = buildAnalysisPrompt({
    portfolioState: request.portfolioState,
    openPositions: request.openPositions,
    marketData: request.marketData,
    lastDecisions: request.lastDecisions,
    config: request.config,
    behavior: request.behavior,
    personaMd: request.personaMd,
    behaviorMd: request.behaviorMd,
    roleMd: request.roleMd,
  });

  return {
    userPrompt,
    fullPrompt: `${systemPrompt}\n\n${userPrompt}`,
  };
}

export function buildPerpTradeDecisionPrompt(request: PerpTradeDecisionRequest): {
  userPrompt: string;
  fullPrompt: string;
} {
  const systemPrompt = BASE_AGENT_PROMPT + buildPerpJsonSchemaInstruction();
  const userPrompt = buildPerpAnalysisPrompt({
    portfolioState: request.portfolioState,
    currentPositionState: request.currentPositionState,
    marketData: request.marketData,
    lastDecisions: request.lastDecisions,
    config: request.config,
    behavior: request.behavior,
    personaMd: request.personaMd,
    behaviorMd: request.behaviorMd,
    roleMd: request.roleMd,
  });

  return {
    userPrompt,
    fullPrompt: `${systemPrompt}\n\n${userPrompt}`,
  };
}
