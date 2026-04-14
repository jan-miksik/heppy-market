import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  parseManagerDecisions,
  buildManagerPrompt,
  executeManagerAction,
  normalizeManagerAnalysisInterval,
} from '../src/agents/manager-loop.js';
import type { ManagedAgentSnapshot, ManagerMemory, ManagerDecision } from '../src/agents/manager-loop.js';
import { DEFAULT_FREE_AGENT_MODEL } from '@something-in-loop/shared';
import { agentManagers, agents } from '../src/db/schema.js';

const doClientMocks = vi.hoisted(() => ({
  startTradingAgentDo: vi.fn(),
  stopTradingAgentDo: vi.fn(),
  pauseTradingAgentDo: vi.fn(),
  setTradingAgentIntervalDo: vi.fn(),
  syncTradingAgentConfigDo: vi.fn(),
}));

vi.mock('../src/lib/do-clients.js', () => doClientMocks);

const mockAgent: ManagedAgentSnapshot = {
  id: 'agent_001',
  name: 'Test Agent',
  status: 'running',
  llmModel: 'nvidia/nemotron-3-super-120b-a12b:free',
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
  llmModel: 'nvidia/nemotron-3-super-120b-a12b:free',
  temperature: 0.7,
  decisionInterval: '1h' as const,
  riskParams: { maxTotalDrawdown: 0.2, maxAgents: 10, maxCorrelatedPositions: 3 },
};

function createMockDb(
  agentRows: Array<Record<string, unknown>>,
  managerRows: Array<Record<string, unknown>> = [
    {
      id: 'manager_001',
      config: JSON.stringify({
        riskParams: { maxTotalDrawdown: 0.2, maxAgents: 10, maxCorrelatedPositions: 3 },
      }),
    },
  ],
) {
  const rows = agentRows.map((row) => ({ ...row }));
  const managers = managerRows.map((row) => ({ ...row }));
  const insertSpy = vi.fn(async (values: Record<string, unknown>) => {
    rows.push({ ...values });
  });
  const updateCalls: Array<Record<string, unknown>> = [];
  const updateSpy = vi.fn((values: Record<string, unknown>) => {
    updateCalls.push({ ...values });
    return {
      where: async () => undefined,
    };
  });

  return {
    rows,
    managers,
    insertSpy,
    updateCalls,
    db: {
      select: () => ({
        from: (table: unknown) => ({
          where: async () => {
            if (table === agents) return rows;
            if (table === agentManagers) return managers;
            return [];
          },
        }),
      }),
      insert: () => ({
        values: insertSpy,
      }),
      update: () => ({
        set: updateSpy,
      }),
    } as any,
  };
}

beforeEach(() => {
  Object.values(doClientMocks).forEach((mock) => mock.mockReset());
});

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

  it('repairs truncated JSON arrays by dropping the last incomplete field', () => {
    const raw = `[
      {
        "action": "create_agent",
        "params": {
          "name": "Professor_WETH_USDC",
          "pairs": ["WETH/USDC"],
          "llmModel": "nvidia/nemotron-3-super-120b-a12b:free",
          "temperature": 0.5,
          "analysisInterval": 30,
          "paperBalance": 500,
          "stopLossPct": 4,
          "takeProfitPct": 8,
          "maxPositionSizePct": 15,
          "maxOpenPositions": 1,
          "maxDaily`;

    const decisions = parseManagerDecisions(raw);
    expect(decisions).toHaveLength(1);
    expect(decisions[0].action).toBe('create_agent');
    expect(decisions[0].params?.name).toBe('Professor_WETH_USDC');
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

  it('includes strict allowed analysisInterval constraints', () => {
    const prompt = buildManagerPrompt({
      agents: [mockAgent],
      marketData: [],
      memory: mockMemory,
      managerConfig: mockManagerConfig,
    });
    expect(prompt).toContain('Allowed Agent Analysis Intervals');
    expect(prompt).toContain('"1h"');
    expect(prompt).toContain('"4h"');
    expect(prompt).toContain('"1d"');
  });

  it('includes a paper-only manager restriction', () => {
    const prompt = buildManagerPrompt({
      agents: [mockAgent],
      marketData: [],
      memory: mockMemory,
      managerConfig: mockManagerConfig,
    });
    expect(prompt).toContain('Managers are paper-only');
    expect(prompt).toContain('must never request live, onchain, or Initia-linked agents');
  });
});

describe('normalizeManagerAnalysisInterval', () => {
  it('keeps valid intervals unchanged', () => {
    expect(normalizeManagerAnalysisInterval('1h')).toBe('1h');
    expect(normalizeManagerAnalysisInterval('4h')).toBe('4h');
    expect(normalizeManagerAnalysisInterval('1d')).toBe('1d');
  });

  it('normalizes legacy short intervals to 1h', () => {
    expect(normalizeManagerAnalysisInterval('1m')).toBe('1h');
    expect(normalizeManagerAnalysisInterval('5m')).toBe('1h');
    expect(normalizeManagerAnalysisInterval('15m')).toBe('1h');
    expect(normalizeManagerAnalysisInterval('60')).toBe('1h');
    expect(normalizeManagerAnalysisInterval('300')).toBe('1h');
    expect(normalizeManagerAnalysisInterval('900')).toBe('1h');
  });

  it('normalizes invalid values to fallback', () => {
    expect(normalizeManagerAnalysisInterval('30m')).toBe('1h');
    expect(normalizeManagerAnalysisInterval('abc')).toBe('1h');
    expect(normalizeManagerAnalysisInterval(30)).toBe('1h');
    expect(normalizeManagerAnalysisInterval('bad', '4h')).toBe('4h');
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

  it('creates paper agents even if the decision requests live/onchain fields', async () => {
    const { db, rows, insertSpy } = createMockDb([]);
    const result = await executeManagerAction(
      {
        action: 'create_agent',
        reasoning: 'launch a new paper agent',
        params: {
          name: 'Manager Alpha',
          chain: 'initia',
          isPaper: false,
          initiaWalletAddress: 'init1abc',
          initiaMetadataHash: 'hash_12345678',
          llmModel: 'not-an-allowed-model',
        },
      },
      db,
      {} as any,
      'manager_001',
      'owner_addr'
    );

    expect(result.success).toBe(true);
    expect(insertSpy).toHaveBeenCalledTimes(1);
    expect(rows).toHaveLength(1);
    expect(rows[0].chain).toBe('base');
    expect(rows[0].isPaper).toBe(true);
    const config = JSON.parse(String(rows[0].config));
    expect(config.isPaper).toBe(true);
    expect(config.chain).toBe('base');
    expect(config.initiaWalletAddress).toBeUndefined();
    expect(config.initiaMetadataHash).toBeUndefined();
    expect(config.llmModel).toBe(DEFAULT_FREE_AGENT_MODEL);
    expect(doClientMocks.startTradingAgentDo).toHaveBeenCalledTimes(1);
  });

  it('prevents manager-created agents beyond the configured manager maxAgents', async () => {
    const { db, insertSpy } = createMockDb(
      [
        {
          id: 'agent_001',
          managerId: 'manager_001',
          ownerAddress: 'owner_addr',
          config: JSON.stringify({ isPaper: true }),
        },
      ],
      [
        {
          id: 'manager_001',
          config: JSON.stringify({
            riskParams: { maxTotalDrawdown: 0.2, maxAgents: 1, maxCorrelatedPositions: 3 },
          }),
        },
      ],
    );

    const result = await executeManagerAction(
      {
        action: 'create_agent',
        reasoning: 'launch one more',
        params: { name: 'Overflow Agent' },
      },
      db,
      {} as any,
      'manager_001',
      'owner_addr',
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('max managed agent limit (1)');
    expect(insertSpy).not.toHaveBeenCalled();
    expect(doClientMocks.startTradingAgentDo).not.toHaveBeenCalled();
  });

  it('keeps manager-modified agents in paper mode and strips live fields', async () => {
    const { db, updateCalls } = createMockDb([
      {
        id: 'agent_001',
        name: 'Managed Paper Agent',
        status: 'stopped',
        llmModel: DEFAULT_FREE_AGENT_MODEL,
        isPaper: true,
        config: JSON.stringify({
          name: 'Managed Paper Agent',
          chain: 'base',
          isPaper: true,
          pairs: ['INIT/USD'],
          strategies: ['combined'],
          analysisInterval: '1h',
          paperBalance: 10000,
          temperature: 0.7,
        }),
      },
    ]);

    const result = await executeManagerAction(
      {
        action: 'modify_agent',
        agentId: 'agent_001',
        reasoning: 'tighten settings',
        params: {
          chain: 'initia',
          isPaper: false,
          initiaWalletAddress: 'init1abc',
          analysisInterval: '4h',
          paperBalance: 25000,
        },
      },
      db,
      {} as any,
      'manager_001',
      'owner_addr'
    );

    expect(result.success).toBe(true);
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].chain).toBe('base');
    expect(updateCalls[0].isPaper).toBe(true);
    const config = JSON.parse(String(updateCalls[0].config));
    expect(config.isPaper).toBe(true);
    expect(config.chain).toBe('base');
    expect(config.initiaWalletAddress).toBeUndefined();
    expect(config.analysisInterval).toBe('4h');
    expect(config.paperBalance).toBe(25000);
  });

  it('rejects manager actions against non-paper agents', async () => {
    const { db, updateCalls } = createMockDb([
      {
        id: 'agent_live',
        name: 'Live Agent',
        status: 'running',
        llmModel: DEFAULT_FREE_AGENT_MODEL,
        isPaper: false,
        config: JSON.stringify({
          chain: 'initia',
          isPaper: false,
          pairs: ['INIT/USD'],
          strategies: ['combined'],
          analysisInterval: '1h',
          paperBalance: 10000,
          temperature: 0.7,
        }),
      },
    ]);

    const result = await executeManagerAction(
      {
        action: 'modify_agent',
        agentId: 'agent_live',
        reasoning: 'change settings',
        params: { paperBalance: 12345 },
      },
      db,
      {} as any,
      'manager_001',
      'owner_addr'
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('paper agents');
    expect(updateCalls).toHaveLength(0);
    expect(doClientMocks.syncTradingAgentConfigDo).not.toHaveBeenCalled();
  });
});
