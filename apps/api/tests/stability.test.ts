/**
 * Stability tests — Error handling and retry logic
 * Tests structured error classification, logging format, and failure mode handling.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  AgentLoopError,
  classifyLlmError,
  classifyApiError,
  logStructuredError,
} from '../src/lib/agent-errors.js';

describe('AgentLoopError', () => {
  it('creates error with correct fields', () => {
    const err = new AgentLoopError('LLM_TIMEOUT', 'Request timed out after 90s', { model: 'gpt-4' }, true);
    expect(err.code).toBe('LLM_TIMEOUT');
    expect(err.message).toBe('Request timed out after 90s');
    expect(err.context).toEqual({ model: 'gpt-4' });
    expect(err.recoverable).toBe(true);
    expect(err.name).toBe('AgentLoopError');
    expect(err instanceof Error).toBe(true);
  });

  it('defaults recoverable to true', () => {
    const err = new AgentLoopError('LLM_RATE_LIMIT', 'Rate limit exceeded');
    expect(err.recoverable).toBe(true);
  });

  it('supports non-recoverable errors', () => {
    const err = new AgentLoopError('AGENT_CONFIG_INVALID', 'Bad config', {}, false);
    expect(err.recoverable).toBe(false);
  });
});

describe('classifyLlmError — timeout detection', () => {
  it('classifies timeout message', () => {
    const err = classifyLlmError(new Error('Model request timed out after 90s'));
    expect(err.code).toBe('LLM_TIMEOUT');
    expect(err.recoverable).toBe(true);
  });

  it('classifies "timeout" keyword', () => {
    const err = classifyLlmError(new Error('Request timeout'));
    expect(err.code).toBe('LLM_TIMEOUT');
  });

  it('passes through an existing AgentLoopError unchanged', () => {
    const original = new AgentLoopError('LLM_MALFORMED_RESPONSE', 'Bad JSON');
    const classified = classifyLlmError(original);
    expect(classified).toBe(original);
  });
});

describe('classifyLlmError — rate limit detection', () => {
  it('classifies 429 in message', () => {
    const err = classifyLlmError(new Error('HTTP 429 Too Many Requests'));
    expect(err.code).toBe('LLM_RATE_LIMIT');
    expect(err.recoverable).toBe(true);
  });

  it('classifies "rate limit" text', () => {
    const err = classifyLlmError(new Error('Rate limit exceeded for this model'));
    expect(err.code).toBe('LLM_RATE_LIMIT');
  });

  it('classifies "too many requests"', () => {
    const err = classifyLlmError(new Error('Too many requests, please wait'));
    expect(err.code).toBe('LLM_RATE_LIMIT');
  });
});

describe('classifyLlmError — malformed response detection', () => {
  it('classifies invalid JSON error', () => {
    const err = classifyLlmError(new Error('Model returned invalid JSON: Unexpected token'));
    expect(err.code).toBe('LLM_MALFORMED_RESPONSE');
  });

  it('classifies bare json keyword', () => {
    const err = classifyLlmError(new Error('json parse failed'));
    expect(err.code).toBe('LLM_MALFORMED_RESPONSE');
  });
});

describe('classifyLlmError — network errors', () => {
  it('classifies network error', () => {
    const err = classifyLlmError(new Error('fetch failed: network error'));
    expect(err.code).toBe('LLM_NETWORK_ERROR');
  });

  it('classifies ECONNREFUSED', () => {
    const err = classifyLlmError(new Error('ECONNREFUSED 127.0.0.1:8080'));
    expect(err.code).toBe('LLM_NETWORK_ERROR');
  });

  it('classifies unknown errors as network errors (recoverable)', () => {
    const err = classifyLlmError(new Error('Something completely unexpected'));
    expect(err.code).toBe('LLM_NETWORK_ERROR');
    expect(err.recoverable).toBe(true);
  });

  it('classifies string errors', () => {
    const err = classifyLlmError('raw string error');
    expect(err instanceof AgentLoopError).toBe(true);
    expect(err.message).toBe('raw string error');
  });
});

describe('classifyLlmError — context propagation', () => {
  it('attaches context to the classified error', () => {
    const err = classifyLlmError(new Error('Request timed out after 90s'), { model: 'gpt-4', attempt: 1 });
    expect(err.context).toEqual({ model: 'gpt-4', attempt: 1 });
  });
});

describe('classifyApiError', () => {
  it('classifies 429 as API_RATE_LIMIT', () => {
    const err = classifyApiError(new Error('HTTP 429: rate limit'));
    expect(err.code).toBe('API_RATE_LIMIT');
    expect(err.recoverable).toBe(true);
  });

  it('classifies generic errors as API_NETWORK_ERROR', () => {
    const err = classifyApiError(new Error('Connection refused'));
    expect(err.code).toBe('API_NETWORK_ERROR');
  });

  it('passes through existing AgentLoopError', () => {
    const original = new AgentLoopError('API_RATE_LIMIT', 'Already classified');
    expect(classifyApiError(original)).toBe(original);
  });
});

describe('logStructuredError', () => {
  it('emits a structured log line with error_code and recoverable', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const err = new AgentLoopError('LLM_TIMEOUT', 'timed out', { model: 'gpt-4' }, true);
    logStructuredError('agent-loop', 'agent_abc123', err);

    expect(spy).toHaveBeenCalledOnce();
    const [line] = spy.mock.calls[0];
    expect(line).toContain('error_code=LLM_TIMEOUT');
    expect(line).toContain('recoverable=true');
    expect(line).toContain('agent_abc123');
    expect(line).toContain('"gpt-4"');
    spy.mockRestore();
  });

  it('handles empty context gracefully', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const err = new AgentLoopError('API_NETWORK_ERROR', 'network failed');
    logStructuredError('agent-loop', 'agent_xyz', err);
    const [line] = spy.mock.calls[0];
    expect(line).toContain('error_code=API_NETWORK_ERROR');
    spy.mockRestore();
  });
});

describe('isTransient classification covers retry-worthy codes', () => {
  it('timeout is recoverable', () => {
    const err = classifyLlmError(new Error('Model request timed out after 90s'));
    expect(err.recoverable).toBe(true);
  });

  it('rate limit is recoverable', () => {
    const err = classifyLlmError(new Error('429 Too Many Requests'));
    expect(err.recoverable).toBe(true);
  });

  it('network error is recoverable', () => {
    const err = classifyLlmError(new Error('fetch failed'));
    expect(err.recoverable).toBe(true);
  });
});
