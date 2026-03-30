/**
 * Orchestration tests — AgentManagerDO scheduler registry.
 * Verifies register/unregister/query/sync operations and cron fallback logic.
 */
import { describe, it, expect } from 'vitest';

// ── Scheduler registry logic ──────────────────────────────────────────────────

/** Minimal in-memory scheduler registry (mirrors AgentManagerDO storage logic) */
class SchedulerRegistry {
  private registry: Record<string, string> = {};

  register(agentId: string, interval: string): void {
    this.registry[agentId] = interval;
  }

  unregister(agentId: string): void {
    delete this.registry[agentId];
  }

  getByInterval(interval: string): string[] {
    return Object.entries(this.registry)
      .filter(([, iv]) => iv === interval)
      .map(([id]) => id);
  }

  list(): Record<string, string> {
    return { ...this.registry };
  }

  sync(agents: Array<{ agentId: string; interval: string }>): void {
    this.registry = {};
    for (const { agentId, interval } of agents) {
      if (agentId && interval) this.registry[agentId] = interval;
    }
  }

  get size(): number {
    return Object.keys(this.registry).length;
  }
}

describe('scheduler registry', () => {
  it('registers an agent with its interval', () => {
    const r = new SchedulerRegistry();
    r.register('agent-1', '1h');
    expect(r.size).toBe(1);
    expect(r.list()).toEqual({ 'agent-1': '1h' });
  });

  it('overwrites existing registration on re-register (interval change)', () => {
    const r = new SchedulerRegistry();
    r.register('agent-1', '1h');
    r.register('agent-1', '4h');
    expect(r.size).toBe(1);
    expect(r.list()['agent-1']).toBe('4h');
  });

  it('unregisters an agent', () => {
    const r = new SchedulerRegistry();
    r.register('agent-1', '1h');
    r.unregister('agent-1');
    expect(r.size).toBe(0);
  });

  it('unregistering a non-existent agent is a no-op', () => {
    const r = new SchedulerRegistry();
    expect(() => r.unregister('ghost')).not.toThrow();
    expect(r.size).toBe(0);
  });

  it('getByInterval returns only agents matching the interval', () => {
    const r = new SchedulerRegistry();
    r.register('a1', '1h');
    r.register('a2', '4h');
    r.register('a3', '1h');
    r.register('a4', '1d');

    expect(r.getByInterval('1h').sort()).toEqual(['a1', 'a3']);
    expect(r.getByInterval('4h')).toEqual(['a2']);
    expect(r.getByInterval('1d')).toEqual(['a4']);
  });

  it('sync rebuilds registry from provided list', () => {
    const r = new SchedulerRegistry();
    r.register('stale-agent', '1h');

    r.sync([
      { agentId: 'a1', interval: '1h' },
      { agentId: 'a2', interval: '4h' },
    ]);

    expect(r.size).toBe(2);
    expect(r.list()).toEqual({ a1: '1h', a2: '4h' });
    // stale entry should be gone
    expect(r.list()['stale-agent']).toBeUndefined();
  });

  it('sync skips entries missing agentId or interval', () => {
    const r = new SchedulerRegistry();
    r.sync([
      { agentId: '', interval: '1h' },
      { agentId: 'a1', interval: '' },
      { agentId: 'a2', interval: '4h' },
    ] as Array<{ agentId: string; interval: string }>);

    expect(r.size).toBe(1);
    expect(r.list()['a2']).toBe('4h');
  });

  it('multiple agents with different intervals round-trip correctly', () => {
    const r = new SchedulerRegistry();
    const agents = [
      { agentId: 'hourly-1', interval: '1h' },
      { agentId: 'hourly-2', interval: '1h' },
      { agentId: 'four-hourly-1', interval: '4h' },
      { agentId: 'daily-1', interval: '1d' },
    ];
    for (const a of agents) r.register(a.agentId, a.interval);

    expect(r.getByInterval('1h').length).toBe(2);
    expect(r.getByInterval('4h').length).toBe(1);
    expect(r.getByInterval('1d').length).toBe(1);
    expect(r.size).toBe(4);
  });
});

// ── Cron fallback logic ───────────────────────────────────────────────────────

describe('cron fallback logic', () => {
  /** Simulates the cron handler's interval-matching from D1 data */
  function matchAgentsByInterval(
    agents: Array<{ id: string; config: string }>,
    targetInterval: string
  ): string[] {
    return agents
      .filter((agent) => {
        const config = JSON.parse(agent.config) as { analysisInterval?: string };
        const effectiveInterval =
          config.analysisInterval === '1m' || config.analysisInterval === '5m' || config.analysisInterval === '15m'
            ? '1h'
            : (config.analysisInterval ?? '1h');
        return effectiveInterval === targetInterval;
      })
      .map((a) => a.id);
  }

  it('matches agents by exact interval', () => {
    const agents = [
      { id: 'a1', config: JSON.stringify({ analysisInterval: '1h' }) },
      { id: 'a2', config: JSON.stringify({ analysisInterval: '4h' }) },
      { id: 'a3', config: JSON.stringify({ analysisInterval: '1h' }) },
    ];
    expect(matchAgentsByInterval(agents, '1h').sort()).toEqual(['a1', 'a3']);
    expect(matchAgentsByInterval(agents, '4h')).toEqual(['a2']);
    expect(matchAgentsByInterval(agents, '1d')).toEqual([]);
  });

  it('normalizes legacy short intervals to 1h', () => {
    const agents = [
      { id: 'legacy-1m', config: JSON.stringify({ analysisInterval: '1m' }) },
      { id: 'legacy-5m', config: JSON.stringify({ analysisInterval: '5m' }) },
      { id: 'legacy-15m',  config: JSON.stringify({ analysisInterval: '15m' }) },
    ];
    const result = matchAgentsByInterval(agents, '1h');
    expect(result.sort()).toEqual(['legacy-15m', 'legacy-1m', 'legacy-5m']);
  });

  it('defaults missing analysisInterval to 1h', () => {
    const agents = [
      { id: 'no-interval', config: JSON.stringify({}) },
    ];
    expect(matchAgentsByInterval(agents, '1h')).toEqual(['no-interval']);
    expect(matchAgentsByInterval(agents, '15m')).toEqual([]);
  });
});

// ── Scheduler DO endpoint validation ─────────────────────────────────────────

describe('scheduler endpoint input validation', () => {
  it('register requires agentId and interval', () => {
    const validate = (body: unknown): { ok: boolean; error?: string } => {
      const b = body as Record<string, unknown>;
      if (!b.agentId || !b.interval) return { ok: false, error: 'agentId and interval are required' };
      return { ok: true };
    };

    expect(validate({ agentId: 'a1', interval: '1h' })).toEqual({ ok: true });
    expect(validate({ agentId: 'a1' })).toMatchObject({ ok: false });
    expect(validate({ interval: '1h' })).toMatchObject({ ok: false });
    expect(validate({})).toMatchObject({ ok: false });
  });

  it('unregister requires agentId', () => {
    const validate = (body: unknown): { ok: boolean; error?: string } => {
      const b = body as Record<string, unknown>;
      if (!b.agentId) return { ok: false, error: 'agentId is required' };
      return { ok: true };
    };

    expect(validate({ agentId: 'a1' })).toEqual({ ok: true });
    expect(validate({})).toMatchObject({ ok: false });
  });

  it('sync requires agents array', () => {
    const validate = (body: unknown): { ok: boolean; error?: string } => {
      const b = body as Record<string, unknown>;
      if (!Array.isArray(b.agents)) return { ok: false, error: 'agents array is required' };
      return { ok: true };
    };

    expect(validate({ agents: [] })).toEqual({ ok: true });
    expect(validate({ agents: [{ agentId: 'a1', interval: '1h' }] })).toEqual({ ok: true });
    expect(validate({})).toMatchObject({ ok: false });
    expect(validate({ agents: null })).toMatchObject({ ok: false });
  });
});
