import { describe, it, expect } from 'vitest';
import { isLegalAction, nextState } from '../src/agents/spot-state-machine';

describe('isLegalAction', () => {
  it('HOLD is always legal', () => {
    expect(isLegalAction('FLAT', 'HOLD')).toBe(true);
    expect(isLegalAction('LONG', 'HOLD')).toBe(true);
  });

  it('OPEN_LONG only legal when FLAT', () => {
    expect(isLegalAction('FLAT', 'OPEN_LONG')).toBe(true);
    expect(isLegalAction('LONG', 'OPEN_LONG')).toBe(false);
  });

  it('CLOSE_LONG only legal when LONG', () => {
    expect(isLegalAction('LONG', 'CLOSE_LONG')).toBe(true);
    expect(isLegalAction('FLAT', 'CLOSE_LONG')).toBe(false);
  });
});

describe('nextState', () => {
  it('FLAT + OPEN_LONG → LONG', () => {
    expect(nextState('FLAT', 'OPEN_LONG')).toBe('LONG');
  });

  it('LONG + CLOSE_LONG → FLAT', () => {
    expect(nextState('LONG', 'CLOSE_LONG')).toBe('FLAT');
  });

  it('FLAT + HOLD → FLAT', () => {
    expect(nextState('FLAT', 'HOLD')).toBe('FLAT');
  });

  it('LONG + HOLD → LONG', () => {
    expect(nextState('LONG', 'HOLD')).toBe('LONG');
  });

  it('throws on illegal transition LONG + OPEN_LONG', () => {
    expect(() => nextState('LONG', 'OPEN_LONG')).toThrow('Illegal spot transition');
  });

  it('throws on illegal transition FLAT + CLOSE_LONG', () => {
    expect(() => nextState('FLAT', 'CLOSE_LONG')).toThrow('Illegal spot transition');
  });
});
