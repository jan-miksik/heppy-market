import { describe, it, expect } from 'vitest';
import { isLegalAction, nextState } from '../src/agents/perp-state-machine';

describe('isLegalAction', () => {
  it('HOLD is always legal', () => {
    expect(isLegalAction('FLAT', 'HOLD')).toBe(true);
    expect(isLegalAction('LONG', 'HOLD')).toBe(true);
    expect(isLegalAction('SHORT', 'HOLD')).toBe(true);
  });

  it('OPEN_LONG only legal when FLAT', () => {
    expect(isLegalAction('FLAT', 'OPEN_LONG')).toBe(true);
    expect(isLegalAction('LONG', 'OPEN_LONG')).toBe(false);
    expect(isLegalAction('SHORT', 'OPEN_LONG')).toBe(false);
  });

  it('OPEN_SHORT only legal when FLAT', () => {
    expect(isLegalAction('FLAT', 'OPEN_SHORT')).toBe(true);
    expect(isLegalAction('LONG', 'OPEN_SHORT')).toBe(false);
    expect(isLegalAction('SHORT', 'OPEN_SHORT')).toBe(false);
  });

  it('CLOSE_LONG only legal when LONG', () => {
    expect(isLegalAction('LONG', 'CLOSE_LONG')).toBe(true);
    expect(isLegalAction('FLAT', 'CLOSE_LONG')).toBe(false);
    expect(isLegalAction('SHORT', 'CLOSE_LONG')).toBe(false);
  });

  it('CLOSE_SHORT only legal when SHORT', () => {
    expect(isLegalAction('SHORT', 'CLOSE_SHORT')).toBe(true);
    expect(isLegalAction('FLAT', 'CLOSE_SHORT')).toBe(false);
    expect(isLegalAction('LONG', 'CLOSE_SHORT')).toBe(false);
  });
});

describe('nextState', () => {
  it('FLAT + OPEN_LONG → LONG', () => {
    expect(nextState('FLAT', 'OPEN_LONG')).toBe('LONG');
  });

  it('FLAT + OPEN_SHORT → SHORT', () => {
    expect(nextState('FLAT', 'OPEN_SHORT')).toBe('SHORT');
  });

  it('LONG + CLOSE_LONG → FLAT', () => {
    expect(nextState('LONG', 'CLOSE_LONG')).toBe('FLAT');
  });

  it('SHORT + CLOSE_SHORT → FLAT', () => {
    expect(nextState('SHORT', 'CLOSE_SHORT')).toBe('FLAT');
  });

  it('HOLD → unchanged', () => {
    expect(nextState('FLAT', 'HOLD')).toBe('FLAT');
    expect(nextState('LONG', 'HOLD')).toBe('LONG');
    expect(nextState('SHORT', 'HOLD')).toBe('SHORT');
  });

  it('throws on illegal transitions', () => {
    expect(() => nextState('LONG', 'OPEN_LONG')).toThrow();
    expect(() => nextState('FLAT', 'CLOSE_LONG')).toThrow();
    expect(() => nextState('SHORT', 'OPEN_SHORT')).toThrow();
  });
});
