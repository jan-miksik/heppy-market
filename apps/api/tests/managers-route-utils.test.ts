import { describe, it, expect } from 'vitest';
import { safeParseManagerLogResult } from '../src/routes/managers.js';

describe('safeParseManagerLogResult', () => {
  it('parses valid JSON objects', () => {
    const parsed = safeParseManagerLogResult('{"detail":"ok","llmPromptText":"hello"}');
    expect(parsed).toEqual({ detail: 'ok', llmPromptText: 'hello' });
  });

  it('returns null for invalid JSON', () => {
    expect(safeParseManagerLogResult('{"detail":')).toBeNull();
  });

  it('returns null for valid non-object JSON', () => {
    expect(safeParseManagerLogResult('"text"')).toBeNull();
    expect(safeParseManagerLogResult('42')).toBeNull();
    expect(safeParseManagerLogResult('true')).toBeNull();
    expect(safeParseManagerLogResult('null')).toBeNull();
  });
});
