import { describe, expect, it } from 'vitest';
import { parseJsonObjectOrEmpty, parseJsonOr, parseJsonOrNull, parseJsonRequired } from '../src/lib/json.js';

describe('json utils', () => {
  it('parseJsonRequired returns typed value for valid JSON', () => {
    const parsed = parseJsonRequired<{ a: number }>('{"a":1}');
    expect(parsed).toEqual({ a: 1 });
  });

  it('parseJsonOr returns fallback for invalid JSON', () => {
    const parsed = parseJsonOr('{"a":', { a: 2 });
    expect(parsed).toEqual({ a: 2 });
  });

  it('parseJsonObjectOrEmpty returns empty object for scalars and invalid input', () => {
    expect(parseJsonObjectOrEmpty(null)).toEqual({});
    expect(parseJsonObjectOrEmpty('1')).toEqual({});
    expect(parseJsonObjectOrEmpty('{"a":')).toEqual({});
  });

  it('parseJsonObjectOrEmpty returns object payloads', () => {
    expect(parseJsonObjectOrEmpty('{"x":true}')).toEqual({ x: true });
  });

  it('parseJsonOrNull returns null for invalid JSON', () => {
    expect(parseJsonOrNull('{"x":')).toBeNull();
  });
});
