/**
 * AgentConfigSchema edge-case tests.
 * Covers boundary values, default application, optional behavior block,
 * and field-level rejection that isn't covered in phase1.test.ts.
 */
import { describe, it, expect } from 'vitest';
import {
  AgentConfigSchema,
  AgentBehaviorConfigSchema,
  ENTITY_NAME_MAX_CHARS,
  TradeDecisionSchema,
} from '../../packages/shared/src/validation.ts';

// ── AgentConfigSchema boundaries ─────────────────────────────────────────────

describe('AgentConfigSchema — boundaries', () => {
  it('rejects name shorter than 1 char', () => {
    const r = AgentConfigSchema.safeParse({ name: '' });
    expect(r.success).toBe(false);
  });

  it(`rejects name longer than ${ENTITY_NAME_MAX_CHARS} chars`, () => {
    const r = AgentConfigSchema.safeParse({ name: 'x'.repeat(ENTITY_NAME_MAX_CHARS + 1) });
    expect(r.success).toBe(false);
  });

  it(`accepts name at max boundary (${ENTITY_NAME_MAX_CHARS} chars)`, () => {
    const r = AgentConfigSchema.safeParse({ name: 'x'.repeat(ENTITY_NAME_MAX_CHARS) });
    expect(r.success).toBe(true);
  });

  it('rejects paperBalance below minimum (0)', () => {
    const r = AgentConfigSchema.safeParse({ name: 'Test', paperBalance: -1 });
    expect(r.success).toBe(false);
  });

  it('accepts paperBalance at minimum (0)', () => {
    const r = AgentConfigSchema.safeParse({ name: 'Test', paperBalance: 0 });
    expect(r.success).toBe(true);
  });

  it('rejects paperBalance above maximum (1_000_000)', () => {
    const r = AgentConfigSchema.safeParse({ name: 'Test', paperBalance: 2_000_000 });
    expect(r.success).toBe(false);
  });

  it('rejects stopLossPct below minimum (0.5)', () => {
    const r = AgentConfigSchema.safeParse({ name: 'Test', stopLossPct: 0.1 });
    expect(r.success).toBe(false);
  });

  it('rejects takeProfitPct above maximum (100)', () => {
    const r = AgentConfigSchema.safeParse({ name: 'Test', takeProfitPct: 200 });
    expect(r.success).toBe(false);
  });

  it('rejects maxOpenPositions above 10', () => {
    const r = AgentConfigSchema.safeParse({ name: 'Test', maxOpenPositions: 11 });
    expect(r.success).toBe(false);
  });

  it('rejects pairs array with more than 10 items', () => {
    const r = AgentConfigSchema.safeParse({
      name: 'Test',
      pairs: ['WETH/USDC', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'],
    });
    expect(r.success).toBe(false);
  });

  it('rejects empty pairs array', () => {
    const r = AgentConfigSchema.safeParse({ name: 'Test', pairs: [] });
    expect(r.success).toBe(false);
  });

  it('rejects invalid analysisInterval', () => {
    const r = AgentConfigSchema.safeParse({ name: 'Test', analysisInterval: '2h' });
    expect(r.success).toBe(false);
  });

  it('accepts all valid analysisInterval values', () => {
    for (const interval of ['1h', '4h', '1d']) {
      const r = AgentConfigSchema.safeParse({ name: 'Test', analysisInterval: interval });
      expect(r.success, `interval ${interval} should be valid`).toBe(true);
    }
  });

  it('rejects temperature above 2', () => {
    const r = AgentConfigSchema.safeParse({ name: 'Test', temperature: 3 });
    expect(r.success).toBe(false);
  });

  it('rejects temperature below 0', () => {
    const r = AgentConfigSchema.safeParse({ name: 'Test', temperature: -0.1 });
    expect(r.success).toBe(false);
  });

  it('rejects maxLlmCallsPerHour above 60', () => {
    const r = AgentConfigSchema.safeParse({ name: 'Test', maxLlmCallsPerHour: 61 });
    expect(r.success).toBe(false);
  });
});

// ── AgentConfigSchema defaults ────────────────────────────────────────────────

describe('AgentConfigSchema — defaults', () => {
  const parsed = AgentConfigSchema.parse({ name: 'Default Agent' });

  it('defaults llmModel', () => {
    expect(parsed.llmModel).toBe('nvidia/nemotron-3-super-120b-a12b:free');
  });

  it('defaults paperBalance to 10_000', () => {
    expect(parsed.paperBalance).toBe(10_000);
  });

  it('defaults analysisInterval to 1h', () => {
    expect(parsed.analysisInterval).toBe('1h');
  });

  it('defaults strategies to combined', () => {
    expect(parsed.strategies).toEqual(['combined']);
  });

  it('defaults maxPositionSizePct to 5', () => {
    expect(parsed.maxPositionSizePct).toBe(5);
  });

  it('defaults chain to base', () => {
    expect(parsed.chain).toBe('base');
  });

  it('accepts initia chain + initia metadata fields', () => {
    const r = AgentConfigSchema.safeParse({
      name: 'Initia Agent',
      chain: 'initia',
      initiaWalletAddress: 'init1abcdefghijklmn1234567890',
      initiaMetadataHash: '0xabc123456789',
      initiaMetadataVersion: 1,
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.chain).toBe('initia');
      expect(r.data.initiaWalletAddress).toBe('init1abcdefghijklmn1234567890');
    }
  });

  it('defaults allowFallback to false', () => {
    expect(parsed.allowFallback).toBe(false);
  });

  it('defaults cooldownAfterLossMinutes to 30', () => {
    expect(parsed.cooldownAfterLossMinutes).toBe(30);
  });
});

// ── AgentBehaviorConfigSchema ─────────────────────────────────────────────────

describe('AgentBehaviorConfigSchema', () => {
  it('parses valid behavior config with all defaults', () => {
    const r = AgentBehaviorConfigSchema.safeParse({});
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.riskAppetite).toBe('moderate');
      expect(r.data.style).toBe('swing');
      expect(r.data.decisionSpeed).toBe('measured');
      expect(r.data.defaultBias).toBe('neutral');
    }
  });

  it('rejects fomoProne out of [0, 100]', () => {
    expect(AgentBehaviorConfigSchema.safeParse({ fomoProne: 101 }).success).toBe(false);
    expect(AgentBehaviorConfigSchema.safeParse({ fomoProne: -1 }).success).toBe(false);
  });

  it('rejects invalid riskAppetite', () => {
    const r = AgentBehaviorConfigSchema.safeParse({ riskAppetite: 'yolo' });
    expect(r.success).toBe(false);
  });

  it('accepts nested behavior in AgentConfigSchema', () => {
    const r = AgentConfigSchema.safeParse({
      name: 'Degen Agent',
      behavior: {
        riskAppetite: 'degen',
        style: 'scalper',
        fomoProne: 90,
      },
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.behavior?.riskAppetite).toBe('degen');
    }
  });

  it('rejects behavior with invalid nested field in AgentConfigSchema', () => {
    const r = AgentConfigSchema.safeParse({
      name: 'Bad Agent',
      behavior: {
        style: 'yolo_scalper', // invalid
      },
    });
    expect(r.success).toBe(false);
  });
});

// ── TradeDecisionSchema ───────────────────────────────────────────────────────

describe('TradeDecisionSchema', () => {
  it('accepts valid buy decision', () => {
    const r = TradeDecisionSchema.safeParse({
      action: 'buy',
      confidence: 0.85,
      reasoning: 'RSI oversold + EMA crossover',
      targetPair: 'WETH/USDC',
      suggestedPositionSizePct: 5,
    });
    expect(r.success).toBe(true);
  });

  it('accepts hold with null targetPair', () => {
    const r = TradeDecisionSchema.safeParse({
      action: 'hold',
      confidence: 0.5,
      reasoning: 'No signal',
      targetPair: null,
    });
    expect(r.success).toBe(true);
  });

  it('rejects confidence above 1', () => {
    const r = TradeDecisionSchema.safeParse({
      action: 'buy',
      confidence: 1.5,
      reasoning: 'test',
    });
    expect(r.success).toBe(false);
  });

  it('rejects confidence below 0', () => {
    const r = TradeDecisionSchema.safeParse({
      action: 'buy',
      confidence: -0.1,
      reasoning: 'test',
    });
    expect(r.success).toBe(false);
  });

  it('rejects invalid action', () => {
    const r = TradeDecisionSchema.safeParse({
      action: 'moon',
      confidence: 0.5,
      reasoning: 'test',
    });
    expect(r.success).toBe(false);
  });

  it('requires reasoning field', () => {
    const r = TradeDecisionSchema.safeParse({
      action: 'hold',
      confidence: 0.5,
    });
    expect(r.success).toBe(false);
  });
});
