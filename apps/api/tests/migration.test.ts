/**
 * Migration tests — DO storage versioning and agent config normalization.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  migrateAgentConfig,
  VALID_ANALYSIS_INTERVALS,
  VALID_STRATEGIES,
} from '../src/lib/agent-config-migration.js';
import {
  migrateStorage,
  CURRENT_STORAGE_VERSION,
} from '../src/lib/do-storage-migration.js';

// Stub cloudflare:workers (DurableObjectStorage) — not available in Vitest/Node
vi.mock('cloudflare:workers', () => ({
  DurableObject: class {
    constructor(_state: unknown, _env: unknown) {}
  },
}));

// ── DO storage migration runner ───────────────────────────────────────────────

/** Create a minimal in-memory stub for DurableObjectStorage */
function makeStorageStub(initial: Record<string, unknown> = {}): any {
  const store = new Map<string, unknown>(Object.entries(initial));
  return {
    get: vi.fn(async (key: string) => store.get(key) ?? undefined),
    put: vi.fn(async (key: string, value: unknown) => { store.set(key, value); }),
    _store: store,
  };
}

describe('migrateStorage', () => {
  it('stamps storageVersion on a fresh DO (no version key)', async () => {
    const storage = makeStorageStub();
    await migrateStorage(storage);
    expect(storage._store.get('storageVersion')).toBe(CURRENT_STORAGE_VERSION);
  });

  it('is idempotent — second call does not re-run migrations', async () => {
    const storage = makeStorageStub();
    await migrateStorage(storage);
    const callCount = storage.put.mock.calls.length;

    await migrateStorage(storage);
    // put should not be called again — fast path returned
    expect(storage.put.mock.calls.length).toBe(callCount);
  });

  it('is a no-op when already at current version', async () => {
    const storage = makeStorageStub({ storageVersion: CURRENT_STORAGE_VERSION });
    await migrateStorage(storage);
    // get was called once to read version, put was never called
    expect(storage.put).not.toHaveBeenCalled();
  });

  it('reports the correct CURRENT_STORAGE_VERSION', () => {
    expect(typeof CURRENT_STORAGE_VERSION).toBe('number');
    expect(CURRENT_STORAGE_VERSION).toBeGreaterThanOrEqual(1);
  });

  it('gracefully skips unknown version numbers', async () => {
    // Simulates a DO that was somehow ahead (e.g. rolled back deployment)
    const storage = makeStorageStub({ storageVersion: CURRENT_STORAGE_VERSION + 99 });
    await expect(migrateStorage(storage)).resolves.not.toThrow();
    expect(storage.put).not.toHaveBeenCalled();
  });
});

// ── migrateAgentConfig ────────────────────────────────────────────────────────

describe('migrateAgentConfig — analysisInterval', () => {
  it('maps legacy seconds string "3600" to "1h"', () => {
    const result = migrateAgentConfig({ analysisInterval: '3600' });
    expect(result.analysisInterval).toBe('1h');
  });

  it('maps "900" to "15m"', () => {
    const result = migrateAgentConfig({ analysisInterval: '900' });
    expect(result.analysisInterval).toBe('15m');
  });

  it('maps "14400" to "4h"', () => {
    const result = migrateAgentConfig({ analysisInterval: '14400' });
    expect(result.analysisInterval).toBe('4h');
  });

  it('maps "86400" to "1d"', () => {
    const result = migrateAgentConfig({ analysisInterval: '86400' });
    expect(result.analysisInterval).toBe('1d');
  });

  it('upgrades removed "1m" interval to "15m"', () => {
    const result = migrateAgentConfig({ analysisInterval: '1m' });
    expect(result.analysisInterval).toBe('15m');
  });

  it('upgrades removed "5m" interval to "15m"', () => {
    const result = migrateAgentConfig({ analysisInterval: '5m' });
    expect(result.analysisInterval).toBe('15m');
  });

  it('defaults unknown interval to "1h"', () => {
    const result = migrateAgentConfig({ analysisInterval: '30m' });
    expect(result.analysisInterval).toBe('1h');
  });

  it('preserves valid intervals unchanged', () => {
    for (const interval of VALID_ANALYSIS_INTERVALS) {
      const result = migrateAgentConfig({ analysisInterval: interval });
      expect(result.analysisInterval).toBe(interval);
    }
  });

  it('leaves non-string analysisInterval untouched', () => {
    const result = migrateAgentConfig({ analysisInterval: 3600 });
    expect(result.analysisInterval).toBe(3600); // not a string — pass-through
  });
});

describe('migrateAgentConfig — strategies', () => {
  it('replaces unknown strategy values with "combined"', () => {
    const result = migrateAgentConfig({ strategies: ['moon_shoot', 'rsi_oversold'] });
    expect(result.strategies).toEqual(['combined', 'rsi_oversold']);
  });

  it('replaces empty strategies array with ["combined"]', () => {
    const result = migrateAgentConfig({ strategies: [] });
    expect(result.strategies).toEqual(['combined']);
  });

  it('preserves all valid strategies', () => {
    const valid = [...VALID_STRATEGIES];
    const result = migrateAgentConfig({ strategies: valid });
    expect(result.strategies).toEqual(valid);
  });

  it('leaves non-array strategies untouched', () => {
    const result = migrateAgentConfig({ strategies: 'combined' });
    expect(result.strategies).toBe('combined'); // not an array — pass-through
  });
});

describe('migrateAgentConfig — numeric clamping', () => {
  it('clamps stopLossPct below minimum to 0.5', () => {
    expect(migrateAgentConfig({ stopLossPct: 0.1 }).stopLossPct).toBe(0.5);
  });

  it('clamps stopLossPct above maximum to 50', () => {
    expect(migrateAgentConfig({ stopLossPct: 100 }).stopLossPct).toBe(50);
  });

  it('clamps takeProfitPct above maximum to 100', () => {
    expect(migrateAgentConfig({ takeProfitPct: 200 }).takeProfitPct).toBe(100);
  });

  it('clamps maxPositionSizePct below minimum to 1', () => {
    expect(migrateAgentConfig({ maxPositionSizePct: 0 }).maxPositionSizePct).toBe(1);
  });

  it('rounds and clamps maxOpenPositions', () => {
    expect(migrateAgentConfig({ maxOpenPositions: 15 }).maxOpenPositions).toBe(10);
    expect(migrateAgentConfig({ maxOpenPositions: 0 }).maxOpenPositions).toBe(1);
    expect(migrateAgentConfig({ maxOpenPositions: 2.7 }).maxOpenPositions).toBe(3); // rounds
  });

  it('clamps paperBalance to [100, 1_000_000]', () => {
    expect(migrateAgentConfig({ paperBalance: 50 }).paperBalance).toBe(100);
    expect(migrateAgentConfig({ paperBalance: 5_000_000 }).paperBalance).toBe(1_000_000);
  });

  it('clamps temperature to [0, 2]', () => {
    expect(migrateAgentConfig({ temperature: -1 }).temperature).toBe(0);
    expect(migrateAgentConfig({ temperature: 5 }).temperature).toBe(2);
  });

  it('leaves valid values unchanged', () => {
    const input = {
      stopLossPct: 5,
      takeProfitPct: 7,
      maxPositionSizePct: 10,
      maxOpenPositions: 3,
      paperBalance: 10_000,
      temperature: 0.7,
    };
    const result = migrateAgentConfig(input);
    expect(result.stopLossPct).toBe(5);
    expect(result.takeProfitPct).toBe(7);
    expect(result.maxPositionSizePct).toBe(10);
    expect(result.maxOpenPositions).toBe(3);
    expect(result.paperBalance).toBe(10_000);
    expect(result.temperature).toBe(0.7);
  });

  it('leaves non-numeric fields untouched', () => {
    const result = migrateAgentConfig({ stopLossPct: 'dynamic' });
    expect(result.stopLossPct).toBe('dynamic');
  });
});

describe('migrateAgentConfig — pure function contract', () => {
  it('does not mutate the original config object', () => {
    const original = { analysisInterval: '1m', stopLossPct: 0.1 };
    migrateAgentConfig(original);
    expect(original.analysisInterval).toBe('1m'); // unchanged
    expect(original.stopLossPct).toBe(0.1); // unchanged
  });

  it('preserves unknown keys unchanged', () => {
    const result = migrateAgentConfig({ name: 'My Agent', customField: 42 });
    expect(result.name).toBe('My Agent');
    expect(result.customField).toBe(42);
  });
});
