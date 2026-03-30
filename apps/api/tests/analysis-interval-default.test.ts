import { describe, expect, it } from 'vitest';
import { CreateAgentRequestSchema } from '@something-in-loop/shared';

describe('analysisInterval defaults', () => {
  it('defaults to 1h for new agents', () => {
    const parsed = CreateAgentRequestSchema.parse({ name: 'Test Agent' });
    expect(parsed.analysisInterval).toBe('1h');
  });
});

