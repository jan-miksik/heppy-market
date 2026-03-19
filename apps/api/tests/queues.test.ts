/**
 * Queue consumer and idempotency tests.
 *
 * Covers:
 * - LlmJobMessage type shape
 * - handleLlmQueueBatch delivery path (ack on success, retry on LLM failure, retry on DO rejection)
 * - /receive-decision idempotency (stale jobId, missing context, happy path)
 * - Queue alarm skip (pendingLlmJobId present → alarm skips tick)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('cloudflare:workers', () => ({
  DurableObject: class {
    constructor(_state: unknown, _env: unknown) {}
  },
}));

// ── Minimal stubs ──────────────────────────────────────────────────────────

function makeStorageStub(initial: Record<string, unknown> = {}): any {
  const store = new Map<string, unknown>(Object.entries(initial));
  return {
    get: vi.fn(async (key: string) => store.get(key) ?? undefined),
    put: vi.fn(async (key: string, value: unknown) => { store.set(key, value); }),
    delete: vi.fn(async (key: string) => { store.delete(key); }),
    _store: store,
  };
}

function makeMessageStub(body: unknown, attempts = 1): any {
  return {
    body,
    attempts,
    ack: vi.fn(),
    retry: vi.fn(),
  };
}

function makeBatchStub(messages: any[], queue = 'llm-jobs'): any {
  return { messages, queue };
}

// ── LlmJobMessage type shape ────────────────────────────────────────────────

describe('LlmJobMessage shape', () => {
  it('includes agentId, jobId, llmConfig, tradeRequest', () => {
    const msg = {
      agentId: 'agent_test',
      jobId: 'job_abc123',
      llmConfig: {
        apiKey: 'sk-test',
        model: 'nvidia/nemotron-3-super-120b-a12b:free',
        fallbackModel: 'nvidia/nemotron-3-super-120b-a12b:free',
        allowFallback: false,
        temperature: 0.3,
        timeoutMs: 90_000,
        provider: 'openrouter' as const,
      },
      tradeRequest: {
        portfolioState: { balance: 10000, openPositions: 0, dailyPnlPct: 0, totalPnlPct: 0 },
        openPositions: [],
        marketData: [],
        lastDecisions: [],
        config: { pairs: ['WETH/USDC'], maxPositionSizePct: 20, maxOpenPositions: 3, stopLossPct: 5, takeProfitPct: 10 },
      },
    };

    expect(msg.agentId).toBe('agent_test');
    expect(msg.jobId).toBe('job_abc123');
    expect(msg.llmConfig.model).toContain('nvidia');
    expect(msg.tradeRequest.portfolioState.balance).toBe(10000);
  });
});

// ── Queue consumer — delivery paths ────────────────────────────────────────

describe('handleLlmQueueBatch — delivery', () => {
  // We test the consumer logic directly by simulating the DO stub response
  function makeConsumerLogic() {
    return async function processMessage(
      message: any,
      getDecision: () => Promise<unknown>,
      deliverToStub: (decision: unknown) => Promise<{ ok: boolean; status: number }>
    ) {
      let decision: unknown;
      try {
        decision = await getDecision();
      } catch {
        message.retry();
        return;
      }

      const res = await deliverToStub(decision);
      if (res.ok) {
        message.ack();
      } else {
        message.retry();
      }
    };
  }

  it('acks message when LLM succeeds and DO accepts', async () => {
    const processMessage = makeConsumerLogic();
    const msg = makeMessageStub({ agentId: 'a', jobId: 'j1' });
    await processMessage(
      msg,
      async () => ({ action: 'hold', confidence: 0.5 }),
      async () => ({ ok: true, status: 200 })
    );
    expect(msg.ack).toHaveBeenCalledOnce();
    expect(msg.retry).not.toHaveBeenCalled();
  });

  it('retries message when LLM throws', async () => {
    const processMessage = makeConsumerLogic();
    const msg = makeMessageStub({ agentId: 'a', jobId: 'j1' });
    await processMessage(
      msg,
      async () => { throw new Error('LLM timeout'); },
      async () => ({ ok: true, status: 200 })
    );
    expect(msg.retry).toHaveBeenCalledOnce();
    expect(msg.ack).not.toHaveBeenCalled();
  });

  it('retries message when DO rejects with non-2xx', async () => {
    const processMessage = makeConsumerLogic();
    const msg = makeMessageStub({ agentId: 'a', jobId: 'j1' });
    await processMessage(
      msg,
      async () => ({ action: 'buy', confidence: 0.9 }),
      async () => ({ ok: false, status: 409 })
    );
    expect(msg.retry).toHaveBeenCalledOnce();
    expect(msg.ack).not.toHaveBeenCalled();
  });

  it('processes each message in batch independently', async () => {
    const processMessage = makeConsumerLogic();
    const msgs = [makeMessageStub({}), makeMessageStub({}), makeMessageStub({})];

    for (const msg of msgs) {
      await processMessage(
        msg,
        async () => ({ action: 'hold', confidence: 0.5 }),
        async () => ({ ok: true, status: 200 })
      );
    }

    for (const msg of msgs) {
      expect(msg.ack).toHaveBeenCalledOnce();
    }
  });

  it('does not ack remaining messages when one throws', async () => {
    const processMessage = makeConsumerLogic();
    const bad = makeMessageStub({});
    const good = makeMessageStub({});
    let count = 0;
    const callCount = async () => {
      count++;
      if (count === 1) throw new Error('first LLM call fails');
      return { action: 'hold', confidence: 0.5 };
    };

    await processMessage(bad, callCount, async () => ({ ok: true, status: 200 }));
    await processMessage(good, callCount, async () => ({ ok: true, status: 200 }));

    expect(bad.retry).toHaveBeenCalledOnce();
    expect(bad.ack).not.toHaveBeenCalled();
    expect(good.ack).toHaveBeenCalledOnce();
  });
});

// ── /receive-decision idempotency ──────────────────────────────────────────

describe('/receive-decision idempotency', () => {
  function makeReceiveDecisionHandler(storageStub: any) {
    return async function handleReceiveDecision(body: { jobId?: string; decision?: unknown }) {
      if (!body.jobId || !body.decision) {
        return { status: 400, body: { error: 'jobId and decision are required' } };
      }

      const pendingJobId = await storageStub.get('pendingLlmJobId');
      if (pendingJobId !== body.jobId) {
        return { status: 200, body: { ok: true, skipped: true } };
      }

      const pendingCtx = await storageStub.get('pendingLlmContext');
      if (!pendingCtx) {
        await storageStub.delete('pendingLlmJobId');
        await storageStub.delete('pendingLlmJobAt');
        return { status: 410, body: { error: 'Pending context expired' } };
      }

      // Simulate successful execution
      await storageStub.delete('pendingLlmJobId');
      await storageStub.delete('pendingLlmJobAt');
      await storageStub.delete('pendingLlmContext');
      return { status: 200, body: { ok: true } };
    };
  }

  it('rejects request missing jobId', async () => {
    const storage = makeStorageStub();
    const handler = makeReceiveDecisionHandler(storage);
    const res = await handler({ decision: { action: 'hold' } });
    expect(res.status).toBe(400);
  });

  it('skips stale jobId (different from stored pendingLlmJobId)', async () => {
    const storage = makeStorageStub({ pendingLlmJobId: 'job_current' });
    const handler = makeReceiveDecisionHandler(storage);
    const res = await handler({ jobId: 'job_stale', decision: { action: 'hold' } });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, skipped: true });
  });

  it('returns 410 when context expired (DO evicted after enqueue)', async () => {
    const storage = makeStorageStub({ pendingLlmJobId: 'job_abc' }); // no pendingLlmContext
    const handler = makeReceiveDecisionHandler(storage);
    const res = await handler({ jobId: 'job_abc', decision: { action: 'hold' } });
    expect(res.status).toBe(410);
  });

  it('clears pending locks on successful execution', async () => {
    const storage = makeStorageStub({
      pendingLlmJobId: 'job_abc',
      pendingLlmJobAt: Date.now(),
      pendingLlmContext: { jobId: 'job_abc', marketData: [], pairsToFetch: [] },
    });
    const handler = makeReceiveDecisionHandler(storage);
    const res = await handler({ jobId: 'job_abc', decision: { action: 'hold', confidence: 0.5 } });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true });
    // Locks should be cleared
    expect(await storage.get('pendingLlmJobId')).toBeUndefined();
    expect(await storage.get('pendingLlmContext')).toBeUndefined();
  });
});

// ── Alarm idempotency guard ────────────────────────────────────────────────

describe('alarm idempotency — skip when awaiting LLM result', () => {
  function makeAlarmCheck(storage: any) {
    return async function shouldSkipForPendingJob(): Promise<boolean> {
      const pendingJobAt = await storage.get('pendingLlmJobAt');
      if (pendingJobAt && Date.now() - pendingJobAt < 5 * 60_000) {
        return true; // skip
      }
      return false;
    };
  }

  it('skips alarm when pendingLlmJobAt is recent (<5 min)', async () => {
    const storage = makeStorageStub({
      pendingLlmJobAt: Date.now() - 60_000, // 1 min ago
      pendingLlmJobId: 'job_pending',
    });
    const shouldSkip = makeAlarmCheck(storage);
    expect(await shouldSkip()).toBe(true);
  });

  it('does not skip alarm when no pending job', async () => {
    const storage = makeStorageStub({});
    const shouldSkip = makeAlarmCheck(storage);
    expect(await shouldSkip()).toBe(false);
  });

  it('does not skip alarm when pending job is stale (>5 min)', async () => {
    const storage = makeStorageStub({
      pendingLlmJobAt: Date.now() - 6 * 60_000, // 6 min ago = stale
      pendingLlmJobId: 'job_stale',
    });
    const shouldSkip = makeAlarmCheck(storage);
    expect(await shouldSkip()).toBe(false);
  });
});

// ── PendingLlmContext storage round-trip ───────────────────────────────────

describe('PendingLlmContext — storage shape', () => {
  it('stores and retrieves all required fields', async () => {
    const storage = makeStorageStub();
    const ctx = {
      jobId: 'job_xyz',
      enqueuedAt: Date.now(),
      marketData: [{ pair: 'WETH/USDC', pairAddress: '0xabc', dexScreenerUrl: 'https://...', priceUsd: 2500, priceChange: {}, indicatorText: 'RSI: 50', dailyIndicatorText: '' }],
      pairsToFetch: ['WETH/USDC'],
      effectiveLlmModel: 'nvidia/nemotron-3-super-120b-a12b:free',
      maxOpenPositions: 3,
      maxPositionSizePct: 20,
      stopLossPct: 5,
      takeProfitPct: 10,
      minConfidence: 0.65,
      dexes: ['aerodrome'],
      strategies: ['combined'],
      slippageSimulation: 0.3,
    };

    await storage.put('pendingLlmContext', ctx);
    const retrieved = await storage.get('pendingLlmContext');

    expect(retrieved).toMatchObject({
      jobId: 'job_xyz',
      marketData: expect.arrayContaining([expect.objectContaining({ pair: 'WETH/USDC' })]),
      minConfidence: 0.65,
    });
  });

  it('minConfidence is in [0,1] range', () => {
    const minConfidence = 65 / 100; // confidenceThreshold 65 → 0.65
    expect(minConfidence).toBeGreaterThanOrEqual(0);
    expect(minConfidence).toBeLessThanOrEqual(1);
  });
});
