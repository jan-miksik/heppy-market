import { describe, it, expect, vi } from 'vitest';
import { parseManagerDecisions, buildManagerPrompt, executeManagerAction } from '../src/agents/manager-loop.js';
import type { ManagedAgentSnapshot, ManagerMemory, ManagerDecision } from '../src/agents/manager-loop.js';

const mockAgent: ManagedAgentSnapshot = {
  id: 'agent_001',
  name: 'Test Agent',
  status: 'running',
  llmModel: 'nvidia/nemotron-3-nano-30b-a3b:free',
  config: {
    pairs: ['WETH/USDC'],
    strategies: ['combined'],
    maxPositionSizePct: 5,
    analysisInterval: '1h',
    paperBalance: 10000,
    temperature: 0.7,
  },
  performance: {
    balance: 10500,
    totalPnlPct: 5.0,
    winRate: 0.6,
    totalTrades: 10,
    sharpeRatio: 1.2,
    maxDrawdown: 0.03,
  },
  recentTrades: [],
};

const mockMemory: ManagerMemory = {
  hypotheses: [],
  parameter_history: [],
  market_regime: null,
  last_evaluation_at: '',
};

const mockManagerConfig = {
  llmModel: 'nvidia/nemotron-3-nano-30b-a3b:free',
  temperature: 0.7,
  decisionInterval: '1h' as const,
  riskParams: { maxTotalDrawdown: 0.2, maxAgents: 10, maxCorrelatedPositions: 3 },
};

describe('parseManagerDecisions', () => {
  it('parses valid JSON array of decisions', () => {
    const raw = JSON.stringify([
      { action: 'hold', agentId: 'agent_001', reasoning: 'performing well' },
    ]);
    const decisions = parseManagerDecisions(raw);
    expect(decisions).toHaveLength(1);
    expect(decisions[0].action).toBe('hold');
    expect(decisions[0].agentId).toBe('agent_001');
  });

  it('strips reasoning tags from response', () => {
    const raw = '<think>internal thoughts</think>[{"action":"hold","agentId":"a1","reasoning":"ok"}]';
    const decisions = parseManagerDecisions(raw);
    expect(decisions).toHaveLength(1);
    expect(decisions[0].action).toBe('hold');
  });

  it('returns empty array on invalid JSON', () => {
    const decisions = parseManagerDecisions('not json at all');
    expect(decisions).toEqual([]);
  });

  it('filters out decisions with invalid actions', () => {
    const raw = JSON.stringify([
      { action: 'hold', agentId: 'a1', reasoning: 'ok' },
      { action: 'invalid_action', agentId: 'a2', reasoning: 'bad' },
    ]);
    const decisions = parseManagerDecisions(raw);
    expect(decisions).toHaveLength(1);
    expect(decisions[0].action).toBe('hold');
  });

  it('handles markdown code blocks wrapping JSON', () => {
    const raw = '```json\n[{"action":"hold","agentId":"a1","reasoning":"ok"}]\n```';
    const decisions = parseManagerDecisions(raw);
    expect(decisions).toHaveLength(1);
  });
});

describe('buildManagerPrompt', () => {
  it('includes agent performance data', () => {
    const prompt = buildManagerPrompt({
      agents: [mockAgent],
      marketData: [],
      memory: mockMemory,
      managerConfig: mockManagerConfig,
    });
    expect(prompt).toContain('Test Agent');
    expect(prompt).toContain('5.0');
    expect(prompt).toContain('WETH/USDC');
  });

  it('includes memory hypotheses when present', () => {
    const memoryWithHypothesis: ManagerMemory = {
      ...mockMemory,
      hypotheses: [{ description: 'Lower temp helps', tested_at: '2026-01-01', outcome: 'confirmed', still_valid: true }],
    };
    const prompt = buildManagerPrompt({
      agents: [mockAgent],
      marketData: [],
      memory: memoryWithHypothesis,
      managerConfig: mockManagerConfig,
    });
    expect(prompt).toContain('Lower temp helps');
  });

  it('includes all valid action types in prompt', () => {
    const prompt = buildManagerPrompt({
      agents: [mockAgent],
      marketData: [],
      memory: mockMemory,
      managerConfig: mockManagerConfig,
    });
    expect(prompt).toContain('create_agent');
    expect(prompt).toContain('pause_agent');
    expect(prompt).toContain('modify_agent');
    expect(prompt).toContain('terminate_agent');
    expect(prompt).toContain('hold');
  });

  it('includes market data when provided', () => {
    const prompt = buildManagerPrompt({
      agents: [mockAgent],
      marketData: [{ pair: 'WETH/USDC', priceUsd: 3500, priceChange: { h1: 1.2, h24: -0.5 } }],
      memory: mockMemory,
      managerConfig: mockManagerConfig,
    });
    expect(prompt).toContain('3500');
  });
});

describe('executeManagerAction', () => {
  it('returns success for hold action without calling DB', async () => {
    const mockDb = {} as any;
    const mockEnv = {} as any;
    const result = await executeManagerAction(
      { action: 'hold', reasoning: 'all good' },
      mockDb,
      mockEnv,
      'manager_001',
      'owner_addr'
    );
    expect(result.success).toBe(true);
  });

  it('returns error for unknown action', async () => {
    const mockDb = {} as any;
    const mockEnv = {} as any;
    const result = await executeManagerAction(
      { action: 'unknown_action' as any, reasoning: 'test' },
      mockDb,
      mockEnv,
      'manager_001',
      'owner_addr'
    );
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('returns error for pause_agent without agentId', async () => {
    const mockDb = {} as any;
    const mockEnv = {} as any;
    const result = await executeManagerAction(
      { action: 'pause_agent', reasoning: 'bad perf' },
      mockDb,
      mockEnv,
      'manager_001',
      'owner_addr'
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('agentId');
  });
});
