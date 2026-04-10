import { PerpTradeDecisionSchema, TradeDecisionSchema } from '@something-in-loop/shared';
import type { PerpTradeDecision, TradeDecision } from '@something-in-loop/shared';

/**
 * Extract a JSON object from raw LLM text.
 * Handles: plain JSON, markdown code blocks, reasoning tags (<think>...</think>).
 */
export function extractJson(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fenced) return fenced[1].trim();

  text = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end > start) return text.slice(start, end + 1);

  return text.trim();
}

export function parseTradeDecisionResponse(text: string): TradeDecision {
  const parsed = parseJsonText(text);
  const object = TradeDecisionSchema.parse(parsed);
  return {
    ...object,
    targetPair: object.targetPair ?? undefined,
    suggestedPositionSizePct: object.suggestedPositionSizePct ?? undefined,
  };
}

export function parsePerpTradeDecisionResponse(text: string): PerpTradeDecision {
  const parsed = parseJsonText(text);
  return PerpTradeDecisionSchema.parse(parsed);
}

function parseJsonText(text: string): unknown {
  const json = extractJson(text);
  if (!json.trim()) {
    throw new Error('Model returned empty response');
  }

  try {
    return JSON.parse(json);
  } catch (parseErr) {
    throw new Error(
      `Model returned invalid JSON: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}. Raw length: ${json.length}`,
    );
  }
}
