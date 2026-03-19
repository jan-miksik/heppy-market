/**
 * Structured error types for the agent loop.
 *
 * Every error has:
 *  - code: machine-readable category
 *  - message: human-readable detail
 *  - context: optional key-value metadata (agentId, model, pair, etc.)
 *  - recoverable: whether the current alarm tick can safely continue after this error
 */

export type ErrorCode =
  | 'LLM_TIMEOUT'
  | 'LLM_MALFORMED_RESPONSE'
  | 'LLM_RATE_LIMIT'
  | 'LLM_NETWORK_ERROR'
  | 'LLM_ALL_MODELS_FAILED'
  | 'API_NETWORK_ERROR'
  | 'API_RATE_LIMIT'
  | 'PRICE_RESOLUTION_FAILED'
  | 'AGENT_CONFIG_INVALID'
  | 'TRADE_PERSIST_FAILED';

export class AgentLoopError extends Error {
  readonly code: ErrorCode;
  readonly context: Record<string, unknown>;
  /** True = the loop can skip this step and continue; False = abort the tick */
  readonly recoverable: boolean;

  constructor(
    code: ErrorCode,
    message: string,
    context: Record<string, unknown> = {},
    recoverable = true
  ) {
    super(message);
    this.name = 'AgentLoopError';
    this.code = code;
    this.context = context;
    this.recoverable = recoverable;
  }
}

/**
 * Classify a raw error into an AgentLoopError.
 * Detects timeout, rate-limit (429), and network errors from message text.
 */
export function classifyLlmError(
  err: unknown,
  context: Record<string, unknown> = {}
): AgentLoopError {
  if (err instanceof AgentLoopError) return err;

  const msg = err instanceof Error ? err.message : String(err);
  const lower = msg.toLowerCase();

  if (lower.includes('timed out') || lower.includes('timeout')) {
    return new AgentLoopError('LLM_TIMEOUT', msg, context, true);
  }
  if (lower.includes('429') || lower.includes('rate limit') || lower.includes('too many requests')) {
    return new AgentLoopError('LLM_RATE_LIMIT', msg, context, true);
  }
  if (lower.includes('invalid json') || lower.includes('json')) {
    return new AgentLoopError('LLM_MALFORMED_RESPONSE', msg, context, true);
  }
  if (lower.includes('network') || lower.includes('fetch') || lower.includes('econnrefused')) {
    return new AgentLoopError('LLM_NETWORK_ERROR', msg, context, true);
  }
  return new AgentLoopError('LLM_NETWORK_ERROR', msg, context, true);
}

export function classifyApiError(
  err: unknown,
  context: Record<string, unknown> = {}
): AgentLoopError {
  if (err instanceof AgentLoopError) return err;

  const msg = err instanceof Error ? err.message : String(err);
  const lower = msg.toLowerCase();

  if (lower.includes('429') || lower.includes('rate limit') || lower.includes('too many requests')) {
    return new AgentLoopError('API_RATE_LIMIT', msg, context, true);
  }
  return new AgentLoopError('API_NETWORK_ERROR', msg, context, true);
}

/** Emit a single structured log line for an error */
export function logStructuredError(
  prefix: string,
  agentId: string,
  err: AgentLoopError
): void {
  const ctx = Object.entries(err.context)
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
    .join(' ');
  console.error(
    `[${prefix}] ${agentId} error_code=${err.code} recoverable=${err.recoverable}${ctx ? ' ' + ctx : ''} message=${JSON.stringify(err.message)}`
  );
}
