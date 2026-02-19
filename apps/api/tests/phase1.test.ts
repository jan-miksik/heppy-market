/**
 * Phase 1 tests — Foundation
 * Tests the Drizzle schema structure and utility functions.
 * These run in Node without requiring a Workers runtime.
 */
import { describe, it, expect } from 'vitest';
import { generateId, nowIso, clamp, autonomyLevelToInt, intToAutonomyLevel } from '../src/lib/utils.js';

describe('Phase 1: Utilities', () => {
  it('generateId produces a non-empty string', () => {
    const id = generateId();
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
  });

  it('generateId with prefix includes prefix', () => {
    const id = generateId('agent');
    expect(id.startsWith('agent_')).toBe(true);
  });

  it('two generateId calls produce different IDs', () => {
    const a = generateId();
    const b = generateId();
    expect(a).not.toBe(b);
  });

  it('nowIso returns a valid ISO string', () => {
    const ts = nowIso();
    expect(() => new Date(ts)).not.toThrow();
    expect(new Date(ts).getTime()).toBeGreaterThan(0);
  });

  it('clamp works correctly', () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-5, 0, 10)).toBe(0);
    expect(clamp(15, 0, 10)).toBe(10);
  });

  it('autonomyLevelToInt maps correctly', () => {
    expect(autonomyLevelToInt('full')).toBe(1);
    expect(autonomyLevelToInt('guided')).toBe(2);
    expect(autonomyLevelToInt('strict')).toBe(3);
  });

  it('intToAutonomyLevel maps correctly', () => {
    expect(intToAutonomyLevel(1)).toBe('full');
    expect(intToAutonomyLevel(2)).toBe('guided');
    expect(intToAutonomyLevel(3)).toBe('strict');
  });
});

describe('Phase 1: Agent Config Validation', async () => {
  const { AgentConfigSchema } = await import('/workspace/packages/shared/src/validation.ts');

  it('validates default config', () => {
    const result = AgentConfigSchema.safeParse({
      name: 'Test Agent',
      autonomyLevel: 'guided',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.paperBalance).toBe(10000);
      expect(result.data.pairs).toContain('WETH/USDC');
      expect(result.data.llmModel).toBe('nvidia/nemotron-3-nano-30b-a3b:free');
    }
  });

  it('rejects invalid autonomy level', () => {
    const result = AgentConfigSchema.safeParse({
      name: 'Test',
      autonomyLevel: 'yolo',
    });
    expect(result.success).toBe(false);
  });

  it('rejects position size over 100%', () => {
    const result = AgentConfigSchema.safeParse({
      name: 'Test',
      autonomyLevel: 'strict',
      maxPositionSizePct: 150,
    });
    expect(result.success).toBe(false);
  });

  it('accepts valid full config', () => {
    const result = AgentConfigSchema.safeParse({
      name: 'My Agent',
      autonomyLevel: 'full',
      pairs: ['WETH/USDC', 'cbBTC/WETH'],
      paperBalance: 50000,
      stopLossPct: 3,
      takeProfitPct: 6,
      strategies: ['rsi_oversold', 'ema_crossover'],
      analysisInterval: '15m',
    });
    expect(result.success).toBe(true);
  });
});
