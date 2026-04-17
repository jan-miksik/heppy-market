import { describe, expect, it } from 'vitest';
import { formatCompactPrice, formatRelativeTime, remainingAnalyzeBannerDelayMs } from '../utils/formatting';

describe('formatCompactPrice', () => {
  it('avoids scientific notation for tiny prices', () => {
    expect(formatCompactPrice(2.393e-6)).toBe('0.000002393');
  });

  it('keeps larger prices compact', () => {
    expect(formatCompactPrice(1234.56789)).toBe('1,234.5679');
  });
});

describe('formatRelativeTime', () => {
  it('uses the provided now timestamp so callers can keep it reactive', () => {
    expect(formatRelativeTime('2026-04-17T12:00:00.000Z', Date.parse('2026-04-17T12:00:45.000Z'))).toBe('45s ago');
    expect(formatRelativeTime('2026-04-17T12:00:00.000Z', Date.parse('2026-04-17T12:03:00.000Z'))).toBe('3m ago');
  });
});

describe('remainingAnalyzeBannerDelayMs', () => {
  it('holds the error banner until the grace window expires', () => {
    const startedAt = Date.parse('2026-04-17T12:00:00.000Z');
    const delayMs = 3 * 60_000;

    expect(remainingAnalyzeBannerDelayMs(startedAt, startedAt + 25_000, delayMs)).toBe(155_000);
    expect(remainingAnalyzeBannerDelayMs(startedAt, startedAt + delayMs + 5_000, delayMs)).toBe(0);
  });
});
