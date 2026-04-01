import { describe, it, expect } from 'vitest';
import {
  ManagerConfigSchema,
  CreateManagerRequestSchema,
  CreateAgentRequestSchema,
  InitiaLinkRequestSchema,
  InitiaSyncRequestSchema,
} from './validation.js';
import { filterSupportedBasePairs } from './pairs.js';

describe('ManagerConfigSchema', () => {
  it('accepts valid config', () => {
    const result = ManagerConfigSchema.safeParse({
      llmModel: 'nvidia/nemotron-3-super-120b-a12b:free',
      temperature: 0.7,
      decisionInterval: '1h',
      riskParams: { maxTotalDrawdown: 0.2, maxAgents: 5, maxCorrelatedPositions: 3 },
    });
    expect(result.success).toBe(true);
  });

  it('rejects temperature above 2', () => {
    const result = ManagerConfigSchema.safeParse({
      llmModel: 'any-model',
      temperature: 2.5,
      decisionInterval: '1h',
      riskParams: { maxTotalDrawdown: 0.2, maxAgents: 5, maxCorrelatedPositions: 3 },
    });
    expect(result.success).toBe(false);
  });

  it('applies defaults', () => {
    const result = ManagerConfigSchema.parse({
      llmModel: 'nvidia/nemotron-3-super-120b-a12b:free',
    });
    expect(result.temperature).toBe(0.7);
    expect(result.decisionInterval).toBe('1h');
    expect(result.riskParams.maxTotalDrawdown).toBe(0.2);
    expect(result.riskParams.maxAgents).toBe(3);
  });
});

describe('CreateManagerRequestSchema', () => {
  it('requires name', () => {
    const result = CreateManagerRequestSchema.safeParse({ llmModel: 'any' });
    expect(result.success).toBe(false);
  });

  it('accepts minimal valid request', () => {
    const result = CreateManagerRequestSchema.safeParse({
      name: 'My Manager',
      llmModel: 'nvidia/nemotron-3-super-120b-a12b:free',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.name).toBe('My Manager');
      expect(result.data.temperature).toBe(0.7);
    }
  });
});

describe('filterSupportedBasePairs', () => {
  it('filters to allowlist, keeps order, and de-dupes', () => {
    expect(
      filterSupportedBasePairs([
        'WETH/USDC',
        'PEPE/USD',
        'WETH/USDC',
        'SOL/ETH',
        'AERO/USDC',
      ])
    ).toEqual(['WETH/USDC', 'AERO/USDC']);
  });
});

describe('Initia agent schemas', () => {
  it('accepts chain initia on create agent request', () => {
    const result = CreateAgentRequestSchema.safeParse({
      name: 'Initia Agent',
      chain: 'initia',
      initiaWalletAddress: 'init1abcdefghijklmn1234567890',
      llmModel: 'nvidia/nemotron-3-super-120b-a12b:free',
      pairs: ['WETH/USDC'],
      strategies: ['combined'],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.chain).toBe('initia');
      expect(result.data.initiaWalletAddress).toBe('init1abcdefghijklmn1234567890');
    }
  });

  it('validates initia link payload', () => {
    const result = InitiaLinkRequestSchema.safeParse({
      initiaWalletAddress: 'init1abcdefghijklmn1234567890',
      evmAddress: '0x1234567890abcdef1234567890abcdef12345678',
      txHash: '0xabcdef1234',
      metadataPointer: {
        agentId: 'agent_123',
        version: 1,
        configHash: '0xhash123456',
        labels: { mode: 'hackathon' },
      },
    });
    expect(result.success).toBe(true);
  });

  it('validates initia sync payload', () => {
    const result = InitiaSyncRequestSchema.safeParse({
      state: {
        walletAddress: 'init1abcdefghijklmn1234567890',
        evmAddress: '0x1234567890abcdef1234567890abcdef12345678',
        chainOk: true,
        existsOnchain: true,
        autoSignEnabled: false,
        walletBalanceWei: '10000000000000000',
        vaultBalanceWei: '5000000000000000',
      },
    });
    expect(result.success).toBe(true);
  });
});
