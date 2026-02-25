import { describe, it, expect } from 'vitest';
import { ManagerConfigSchema, CreateManagerRequestSchema } from './validation.js';

describe('ManagerConfigSchema', () => {
  it('accepts valid config', () => {
    const result = ManagerConfigSchema.safeParse({
      llmModel: 'nvidia/nemotron-3-nano-30b-a3b:free',
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
      llmModel: 'nvidia/nemotron-3-nano-30b-a3b:free',
    });
    expect(result.temperature).toBe(0.7);
    expect(result.decisionInterval).toBe('1h');
    expect(result.riskParams.maxTotalDrawdown).toBe(0.2);
    expect(result.riskParams.maxAgents).toBe(10);
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
      llmModel: 'nvidia/nemotron-3-nano-30b-a3b:free',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.name).toBe('My Manager');
      expect(result.data.temperature).toBe(0.7);
    }
  });
});
