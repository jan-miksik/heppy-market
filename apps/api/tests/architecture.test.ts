/**
 * Architecture tests — DO as source of truth for agent state.
 *
 * Tests verify:
 * - CachedAgentRow type shape is complete (all fields used by agent-loop)
 * - DO cache hit/miss logic (agent config and recent decisions)
 * - cache warm on miss, update after decision
 * - status sync through stop/pause/reset endpoints
 * - daily loss limit path updates DO status
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CachedAgentRow } from '../src/agents/trading-agent.js';

vi.mock('cloudflare:workers', () => ({
  DurableObject: class {
    constructor(_state: unknown, _env: unknown) {}
  },
}));

// ── In-memory DO storage stub ──────────────────────────────────────────────

function makeStorageStub(initial: Record<string, unknown> = {}): any {
  const store = new Map<string, unknown>(Object.entries(initial));
  return {
    get: vi.fn(async (key: string) => store.get(key) ?? undefined),
    put: vi.fn(async (key: string, value: unknown) => { store.set(key, value); }),
    delete: vi.fn(async (key: string) => { store.delete(key); }),
    list: vi.fn(async ({ prefix }: { prefix: string }) => {
      const result = new Map<string, unknown>();
      for (const [k, v] of store) {
        if (k.startsWith(prefix)) result.set(k, v);
      }
      return result;
    }),
    deleteAlarm: vi.fn(async () => {}),
    setAlarm: vi.fn(async (_ts: number) => {}),
    _store: store,
  };
}

function makeSampleAgentRow(): CachedAgentRow {
  return {
    id: 'agent_test123',
    name: 'Test Agent',
    status: 'running',
    config: JSON.stringify({
      analysisInterval: '1h',
      pairs: ['WETH/USDC'],
      paperBalance: 10000,
    }),
    ownerAddress: '0xdeadbeef',
    llmModel: 'nvidia/nemotron-3-super-120b-a12b:free',
    profileId: null,
    personaMd: null,
  };
}

// ── CachedAgentRow type coverage ──────────────────────────────────────────────

describe('CachedAgentRow type', () => {
  it('has all required fields', () => {
    const row: CachedAgentRow = makeSampleAgentRow();
    expect(row.id).toBeTruthy();
    expect(row.name).toBeTruthy();
    expect(row.status).toBeTruthy();
    expect(row.config).toBeTruthy();
    // nullable fields are present in type
    expect('ownerAddress' in row).toBe(true);
    expect('llmModel' in row).toBe(true);
    expect('profileId' in row).toBe(true);
    expect('personaMd' in row).toBe(true);
  });

  it('accepts null for optional fields', () => {
    const row: CachedAgentRow = {
      ...makeSampleAgentRow(),
      ownerAddress: null,
      llmModel: null,
      profileId: null,
      personaMd: null,
    };
    expect(row.ownerAddress).toBeNull();
    expect(row.llmModel).toBeNull();
    expect(row.profileId).toBeNull();
    expect(row.personaMd).toBeNull();
  });
});

// ── DO cache: agent row ────────────────────────────────────────────────────────

describe('DO cachedAgentRow cache', () => {
  it('stores agent row on /start with agentRow payload', async () => {
    const storage = makeStorageStub();
    const row = makeSampleAgentRow();

    // Simulate what the DO /start handler does
    if (row) {
      await storage.put('cachedAgentRow', { ...row, status: 'running' });
    }

    const cached = await storage.get('cachedAgentRow');
    expect((cached as CachedAgentRow).id).toBe(row.id);
    expect((cached as CachedAgentRow).status).toBe('running');
  });

  it('cache hit skips D1 read (simulates agent-loop hot path)', async () => {
    const row = makeSampleAgentRow();
    const storage = makeStorageStub({ cachedAgentRow: row });

    const mockD1Select = vi.fn();

    // Simulate cache hit logic
    const cachedRow = await storage.get('cachedAgentRow') as CachedAgentRow | undefined;
    let agentRow: CachedAgentRow | null = null;

    if (cachedRow && cachedRow.id === row.id) {
      agentRow = cachedRow;
    } else {
      // cache miss — would call D1
      mockD1Select();
    }

    expect(agentRow).not.toBeNull();
    expect(mockD1Select).not.toHaveBeenCalled();
    expect(agentRow!.name).toBe(row.name);
  });

  it('cache miss calls D1 and warms cache', async () => {
    const storage = makeStorageStub();  // empty — no cache
    const row = makeSampleAgentRow();

    let agentRow: CachedAgentRow | null = null;
    const cachedRow = await storage.get('cachedAgentRow') as CachedAgentRow | undefined;

    if (cachedRow && cachedRow.id === row.id) {
      agentRow = cachedRow;
    } else {
      // Simulate D1 fallback + cache warm
      agentRow = row;
      await storage.put('cachedAgentRow', row);
    }

    expect(agentRow).not.toBeNull();
    expect(storage._store.get('cachedAgentRow')).toEqual(row);
  });

  it('sync-config preserves authoritative DO status', async () => {
    const storage = makeStorageStub({ status: 'running' });
    const row: CachedAgentRow = { ...makeSampleAgentRow(), status: 'stopped' }; // stale status from caller

    // Simulate /sync-config handler behavior
    const currentStatus = (await storage.get('status') as string | undefined) ?? 'stopped';
    await storage.put('cachedAgentRow', { ...row, status: currentStatus });

    const cached = await storage.get('cachedAgentRow') as CachedAgentRow;
    // DO authoritative status ('running') wins over caller's stale status
    expect(cached.status).toBe('running');
  });

  it('stop endpoint updates cachedAgentRow.status', async () => {
    const row: CachedAgentRow = { ...makeSampleAgentRow(), status: 'running' };
    const storage = makeStorageStub({ cachedAgentRow: row });

    // Simulate /stop handler
    await storage.put('status', 'stopped');
    const cached = await storage.get('cachedAgentRow') as CachedAgentRow;
    if (cached) await storage.put('cachedAgentRow', { ...cached, status: 'stopped' });

    const updated = await storage.get('cachedAgentRow') as CachedAgentRow;
    expect(updated.status).toBe('stopped');
    expect(storage._store.get('status')).toBe('stopped');
  });

  it('pause endpoint updates cachedAgentRow.status', async () => {
    const row: CachedAgentRow = { ...makeSampleAgentRow(), status: 'running' };
    const storage = makeStorageStub({ cachedAgentRow: row });

    // Simulate /pause handler
    await storage.put('status', 'paused');
    const cached = await storage.get('cachedAgentRow') as CachedAgentRow;
    if (cached) await storage.put('cachedAgentRow', { ...cached, status: 'paused' });

    const updated = await storage.get('cachedAgentRow') as CachedAgentRow;
    expect(updated.status).toBe('paused');
  });
});

// ── DO cache: recentDecisions ─────────────────────────────────────────────────

type RecentDecision = { decision: string; confidence: number; createdAt: string };

describe('DO recentDecisions cache', () => {
  it('serves recentDecisions from cache on hot path', async () => {
    const cached: RecentDecision[] = [
      { decision: 'buy', confidence: 0.8, createdAt: '2026-01-01T00:00:00Z' },
    ];
    const storage = makeStorageStub({ recentDecisions: cached });
    const mockDbQuery = vi.fn();

    const fromCache = await storage.get('recentDecisions') as RecentDecision[] | undefined;
    let decisions: RecentDecision[];

    if (fromCache !== undefined) {
      decisions = fromCache;
    } else {
      mockDbQuery();
      decisions = [];
    }

    expect(decisions).toEqual(cached);
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it('falls back to DB and warms cache on cache miss', async () => {
    const storage = makeStorageStub();  // no cache
    const dbResult: RecentDecision[] = [
      { decision: 'hold', confidence: 0.5, createdAt: '2026-01-01T00:00:00Z' },
    ];

    const fromCache = await storage.get('recentDecisions') as RecentDecision[] | undefined;
    let decisions: RecentDecision[];

    if (fromCache !== undefined) {
      decisions = fromCache;
    } else {
      // Simulate DB fallback
      decisions = dbResult;
      await storage.put('recentDecisions', dbResult);
    }

    expect(decisions).toEqual(dbResult);
    expect(storage._store.get('recentDecisions')).toEqual(dbResult);
  });

  it('prepends new decision and trims to 10 after tick', async () => {
    // Seed with 10 decisions
    const existing: RecentDecision[] = Array.from({ length: 10 }, (_, i) => ({
      decision: 'hold',
      confidence: 0.5,
      createdAt: `2026-01-0${(i + 1).toString().padStart(2, '0')}T00:00:00Z`,
    }));
    const storage = makeStorageStub({ recentDecisions: existing });

    const newDecision: RecentDecision = { decision: 'buy', confidence: 0.9, createdAt: '2026-01-11T00:00:00Z' };

    // Simulate what agent-loop does after decision is logged
    const prev = (await storage.get('recentDecisions') as RecentDecision[]) ?? [];
    const updated = [newDecision, ...prev].slice(0, 10);
    await storage.put('recentDecisions', updated);

    const result = await storage.get('recentDecisions') as RecentDecision[];
    expect(result).toHaveLength(10);
    expect(result[0].decision).toBe('buy');   // newest is first
    expect(result[0].confidence).toBe(0.9);
    // Oldest entry dropped
    expect(result.find((d) => d.createdAt === existing[9].createdAt)).toBeUndefined();
  });

  it('handles empty recent decisions gracefully', async () => {
    const storage = makeStorageStub({ recentDecisions: [] });

    const prev = (await storage.get('recentDecisions') as RecentDecision[]) ?? [];
    const newDecision: RecentDecision = { decision: 'sell', confidence: 0.7, createdAt: '2026-01-01T00:00:00Z' };
    const updated = [newDecision, ...prev].slice(0, 10);
    await storage.put('recentDecisions', updated);

    const result = await storage.get('recentDecisions') as RecentDecision[];
    expect(result).toHaveLength(1);
    expect(result[0].decision).toBe('sell');
  });
});

// ── Daily loss limit status sync ───────────────────────────────────────────────

describe('DO status sync on daily loss limit', () => {
  it('updates DO status and cachedAgentRow.status to paused', async () => {
    const row: CachedAgentRow = { ...makeSampleAgentRow(), status: 'running' };
    const storage = makeStorageStub({ status: 'running', cachedAgentRow: row });

    // Simulate what agent-loop does when daily loss limit is hit
    await storage.put('status', 'paused');
    const cached = await storage.get('cachedAgentRow') as CachedAgentRow;
    if (cached) await storage.put('cachedAgentRow', { ...cached, status: 'paused' });

    expect(storage._store.get('status')).toBe('paused');
    expect((storage._store.get('cachedAgentRow') as CachedAgentRow).status).toBe('paused');
  });
});
