import { DurableObject } from 'cloudflare:workers';
import { drizzle } from 'drizzle-orm/d1';
import type { Env } from '../types/env.js';
import { performanceSnapshots, trades } from '../db/schema.js';
import { PaperEngine } from '../services/paper-engine.js';
import type { Position } from '../services/paper-engine.js';
import { runAgentLoop, executeTradeDecision, type PendingLlmContext, type RecentDecision } from './agent-loop.js';
import { generateId, nowIso } from '../lib/utils.js';
import { resolveCurrentPriceUsd } from '../services/price-resolver.js';
import { migrateStorage } from '../lib/do-storage-migration.js';

/**
 * Minimal agent row fields cached in DO storage.
 * Updated on every /start and /sync-config call so agent-loop can skip the D1 read.
 */
export type CachedAgentRow = {
  id: string;
  name: string;
  status: string;
  config: string;       // JSON string (same as agents.config column)
  ownerAddress: string | null;
  llmModel: string | null;
  profileId: string | null;
  personaMd: string | null;
};

/** Interval string → milliseconds */
function normalizeAnalysisInterval(interval: unknown): string {
  if (typeof interval !== 'string') return '1h';
  const trimmed = interval.trim();
  switch (trimmed) {
    case '1m':
    case '5m':
    case '15m':
    case '1h':
      return '1h';
    case '4h':
    case '1d':
      return trimmed;
    default:
      return '1h';
  }
}

/** Interval string → milliseconds */
function intervalToMs(interval: string): number {
  switch (normalizeAnalysisInterval(interval)) {
    case '1h':  return 60 * 60_000;
    case '4h':  return 4 * 60 * 60_000;
    case '1d':  return 24 * 60 * 60_000;
    default:    return 60 * 60_000;
  }
}

/**
 * TradingAgentDO — Durable Object managing a single trading agent instance.
 *
 * Persistent state (via ctx.storage):
 * - agentId: string
 * - status: 'running' | 'stopped' | 'paused'
 * - engineState: serialized PaperEngine state
 * - lastStopOutAt: timestamp of last stop-out (for cooldown)
 *
 * The alarm fires on each analysis interval tick and runs the full agent loop.
 */
export class TradingAgentDO extends DurableObject<Env> {
  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Run any pending DO storage migrations on every request.
    // migrateStorage() exits immediately when already at current version (fast path).
    await migrateStorage(this.ctx.storage).catch((err) => {
      console.warn('[TradingAgentDO] storage migration failed (non-fatal):', err);
    });

    if (url.pathname === '/status') {
      const agentId = (await this.ctx.storage.get<string>('agentId')) ?? null;
      const status = (await this.ctx.storage.get<string>('status')) ?? 'stopped';
      const engineState = await this.ctx.storage.get<ReturnType<PaperEngine['serialize']>>('engineState');
      const balance = engineState?.balance ?? null;
      let nextAlarmAt = (await this.ctx.storage.get<number>('nextAlarmAt')) ?? null;

      // Auto-heal: if running but the alarm is more than 10s overdue, it was likely
      // lost (Wrangler restart in dev, DO eviction). Reschedule in 5s to self-recover.
      if (status === 'running' && nextAlarmAt !== null && nextAlarmAt < Date.now() - 10_000) {
        const healed = Date.now() + 5_000;
        await this.ctx.storage.put('nextAlarmAt', healed);
        await this.ctx.storage.setAlarm(healed);
        nextAlarmAt = healed;
        console.log(`[TradingAgentDO] ${agentId}: alarm was overdue — rescheduled in 5s`);
      }

      return Response.json({ agentId, status, balance, nextAlarmAt });
    }

	  if (url.pathname === '/start' && request.method === 'POST') {
	      const body = (await request.json().catch(() => ({}))) as {
	        agentId: string;
	        paperBalance?: number;
	        slippageSimulation?: number;
	        analysisInterval?: string;
	        agentRow?: CachedAgentRow;  // optional: caller may pass to prime the DO cache
	      };
	      if (typeof body.agentId !== 'string' || body.agentId.trim().length === 0) {
	        return Response.json({ error: 'agentId is required' }, { status: 400 });
	      }
	      const safeAgentId = body.agentId.trim();

	      const currentAgentId = await this.ctx.storage.get<string>('agentId');

	      // Initialize engine only on first start (preserve state on restart)
	      if (!currentAgentId || currentAgentId !== safeAgentId) {
	        const balance = body.paperBalance ?? 10_000;
	        const slippage = body.slippageSimulation ?? 0.3;
	        const engine = new PaperEngine({ balance, slippage });
	        await this.ctx.storage.put('engineState', engine.serialize());
	      }

	      await this.ctx.storage.put('agentId', safeAgentId);
	      await this.ctx.storage.put('status', 'running');
	      const analysisInterval = normalizeAnalysisInterval(body.analysisInterval ?? '1h');
	      await this.ctx.storage.put('analysisInterval', analysisInterval);

      // Cache the full agent row so runAgentLoop can skip the D1 read on every tick.
      if (body.agentRow) {
        await this.ctx.storage.put('cachedAgentRow', { ...body.agentRow, status: 'running' });
      }

      // Schedule first tick
      const intervalMs = intervalToMs(analysisInterval);
      const firstTick = Math.min(5_000, intervalMs); // first tick in 5s (for quick testing)
      const nextAlarmAt = Date.now() + firstTick;
      await this.ctx.storage.put('nextAlarmAt', nextAlarmAt);
      await this.ctx.storage.setAlarm(nextAlarmAt);

      return Response.json({ ok: true, status: 'running' });
    }

    if (url.pathname === '/analyze' && request.method === 'POST') {
      // Run one immediate analysis cycle (manual trigger / cron fallback).
      // Accept init params in body so the DO can be lazily initialized without /start.
      const body = (await request.json().catch(() => ({}))) as {
        agentId?: string;
        paperBalance?: number;
        slippageSimulation?: number;
        analysisInterval?: string;
      };

      let agentId = await this.ctx.storage.get<string>('agentId');

      // Lazy-initialize engine on first analyze (no alarm scheduled)
      if (!agentId && body.agentId) {
        agentId = body.agentId;
        const balance = body.paperBalance ?? 10_000;
        const slippage = body.slippageSimulation ?? 0.3;
        const engine = new PaperEngine({ balance, slippage });
        await this.ctx.storage.put('agentId', agentId);
        await this.ctx.storage.put('engineState', engine.serialize());
        const analysisInterval = normalizeAnalysisInterval(body.analysisInterval ?? '1h');
        await this.ctx.storage.put('analysisInterval', analysisInterval);
        // Don't change status or schedule alarm — that only happens via /start
      }

      if (!agentId) return Response.json({ error: 'Agent not initialized. Start the agent first.' }, { status: 400 });

      // If the caller provides an interval, always sync it (so config edits take effect).
      if (typeof body.analysisInterval === 'string' && body.analysisInterval.trim()) {
        await this.ctx.storage.put('analysisInterval', normalizeAnalysisInterval(body.analysisInterval));
      }

      // Prevent concurrent loop runs (e.g. manual trigger racing with scheduled alarm).
      // Store a timestamp so stale locks (dev restart, crash) self-clear after 10 minutes.
      const LOCK_TTL_MS = 10 * 60_000;
      const lockAt = await this.ctx.storage.get<number>('isLoopRunning');
      if (lockAt && Date.now() - lockAt < LOCK_TTL_MS) {
        return Response.json({ error: 'Analysis already in progress' }, { status: 409 });
      }
      await this.ctx.storage.put('isLoopRunning', Date.now());

      const engineState = await this.ctx.storage.get<ReturnType<PaperEngine['serialize']>>('engineState');
      const engine = engineState
        ? PaperEngine.deserialize(engineState)
        : new PaperEngine({ balance: 10_000, slippage: 0.3 });

      try {
        // forceRun=true allows analysis even if agent is stopped/paused in DB
        // bypassCache=true ensures fresh market data on every manual trigger
        await runAgentLoop(agentId, engine, this.env, this.ctx, { forceRun: true, bypassCache: true });
      } catch (err) {
        console.error(`[TradingAgentDO] manual analyze error for ${agentId}:`, err);
        // Still persist engine state and reschedule alarm before returning error
        try { await this.ctx.storage.put('engineState', engine.serialize()); } catch { /* ignore */ }
        await this.ctx.storage.delete('isLoopRunning');
        await this.rescheduleAlarmIfRunning();
        return Response.json({ error: String(err) }, { status: 500 });
      }

      await this.ctx.storage.delete('isLoopRunning');

      try {
        await this.ctx.storage.put('engineState', engine.serialize());
      } catch (err) {
        console.error(`[TradingAgentDO] failed to persist engine state for ${agentId}:`, err);
      }

      await this.rescheduleAlarmIfRunning();

      return Response.json({ ok: true });
    }

    if (url.pathname === '/set-interval' && request.method === 'POST') {
      const body = (await request.json().catch(() => ({}))) as { analysisInterval?: string };
      const interval = typeof body.analysisInterval === 'string' && body.analysisInterval.trim()
        ? normalizeAnalysisInterval(body.analysisInterval)
        : null;
      if (!interval) return Response.json({ error: 'analysisInterval is required' }, { status: 400 });

      await this.ctx.storage.put('analysisInterval', interval);

      const status = (await this.ctx.storage.get<string>('status')) ?? 'stopped';
      if (status === 'running') {
        const nextAlarmAt = Date.now() + intervalToMs(interval);
        await this.ctx.storage.put('nextAlarmAt', nextAlarmAt);
        await this.ctx.storage.setAlarm(nextAlarmAt);
      }

      return Response.json({ ok: true, analysisInterval: interval });
    }

    if (url.pathname === '/clear-history' && request.method === 'POST') {
      const body = (await request.json().catch(() => ({}))) as {
        agentId?: string;
        paperBalance?: number;
        slippageSimulation?: number;
        analysisInterval?: string;
      };

      const existingStatus = (await this.ctx.storage.get<string>('status')) ?? 'stopped';

      const storedAgentId = await this.ctx.storage.get<string>('agentId');
      if (!storedAgentId && typeof body.agentId === 'string' && body.agentId.trim()) {
        await this.ctx.storage.put('agentId', body.agentId.trim());
      }

      if (typeof body.analysisInterval === 'string' && body.analysisInterval.trim()) {
        await this.ctx.storage.put('analysisInterval', normalizeAnalysisInterval(body.analysisInterval));
      }

      const balance = body.paperBalance ?? 10_000;
      const slippage = body.slippageSimulation ?? 0.3;
      const engine = new PaperEngine({ balance, slippage });
      await this.ctx.storage.put('engineState', engine.serialize());

      await this.ctx.storage.delete('tickCount');
      await this.ctx.storage.delete('pendingTrade');
      await this.ctx.storage.delete('lastStopOutAt');
      await this.ctx.storage.delete('isLoopRunning');

      // Clear any stale per-position warning keys
      const priceMissKeys = await this.ctx.storage.list({ prefix: 'priceMiss:' });
      for (const key of priceMissKeys.keys()) {
        await this.ctx.storage.delete(key);
      }

      if (existingStatus === 'running') {
        // Kick a quick next tick so the UI updates promptly (and then normal scheduling resumes).
        const nextAlarmAt = Date.now() + 5_000;
        await this.ctx.storage.put('nextAlarmAt', nextAlarmAt);
        await this.ctx.storage.setAlarm(nextAlarmAt);
      }

      return Response.json({ ok: true, status: existingStatus });
    }

    if (url.pathname === '/reset' && request.method === 'POST') {
      // Clear engine state and position history — resets paper balance to initial value.
      const body = (await request.json().catch(() => ({}))) as {
        paperBalance?: number;
        slippageSimulation?: number;
      };
      const balance = body.paperBalance ?? 10_000;
      const slippage = body.slippageSimulation ?? 0.3;
      const engine = new PaperEngine({ balance, slippage });
      await this.ctx.storage.put('engineState', engine.serialize());
      await this.ctx.storage.put('status', 'stopped');
      await this.ctx.storage.deleteAlarm();
      const cached = await this.ctx.storage.get<CachedAgentRow>('cachedAgentRow');
      if (cached) await this.ctx.storage.put('cachedAgentRow', { ...cached, status: 'stopped' });
      return Response.json({ ok: true, balance });
    }

    if (url.pathname === '/stop' && request.method === 'POST') {
      await this.ctx.storage.put('status', 'stopped');
      await this.ctx.storage.deleteAlarm();
      const cached = await this.ctx.storage.get<CachedAgentRow>('cachedAgentRow');
      if (cached) await this.ctx.storage.put('cachedAgentRow', { ...cached, status: 'stopped' });
      return Response.json({ ok: true, status: 'stopped' });
    }

    if (url.pathname === '/pause' && request.method === 'POST') {
      await this.ctx.storage.put('status', 'paused');
      await this.ctx.storage.deleteAlarm();
      const cached = await this.ctx.storage.get<CachedAgentRow>('cachedAgentRow');
      if (cached) await this.ctx.storage.put('cachedAgentRow', { ...cached, status: 'paused' });
      return Response.json({ ok: true, status: 'paused' });
    }

    if (url.pathname === '/close-position' && request.method === 'POST') {
      const body = (await request.json().catch(() => ({}))) as { positionId?: string; reason?: string };
      const positionId = typeof body.positionId === 'string' ? body.positionId : '';
      if (!positionId) return Response.json({ error: 'positionId is required' }, { status: 400 });

      const agentId = await this.ctx.storage.get<string>('agentId');
      if (!agentId) return Response.json({ error: 'Agent not initialized' }, { status: 400 });

      const engineState = await this.ctx.storage.get<ReturnType<PaperEngine['serialize']>>('engineState');
      const engine = engineState
        ? PaperEngine.deserialize(engineState)
        : new PaperEngine({ balance: 10_000, slippage: 0.3 });

      const position = engine.openPositions.find((p) => p.id === positionId);
      if (!position) return Response.json({ error: 'Position not found' }, { status: 404 });

      const priceUsd = await resolveCurrentPriceUsd(this.env, position.pair);
      if (!priceUsd || priceUsd <= 0) {
        return Response.json({ error: 'Unable to resolve current price' }, { status: 503 });
      }

      const closed = engine.closePosition(positionId, {
        price: priceUsd,
        reason: body.reason ?? 'Closed manually by user',
        closeReason: 'manual',
      });

      try {
        await this.ctx.storage.put('pendingTrade', closed);
        await this.persistTrade(closed);
        await this.ctx.storage.delete('pendingTrade');
        await this.ctx.storage.delete(`priceMiss:${positionId}`);
      } catch (err) {
        console.error(`[TradingAgentDO] failed to persist manual close trade ${positionId}:`, err);
        // pendingTrade remains in DO storage — agent-loop drain will retry on next tick
      }

      try {
        await this.ctx.storage.put('engineState', engine.serialize());
      } catch (err) {
        console.error(`[TradingAgentDO] failed to persist engine state after manual close for ${agentId}:`, err);
      }

      return Response.json({ ok: true, trade: closed });
    }

    if (url.pathname === '/engine-state') {
      const engineState = await this.ctx.storage.get<ReturnType<PaperEngine['serialize']>>('engineState');
      return Response.json(engineState ?? null);
    }

    if (url.pathname === '/debug') {
      const agentId = (await this.ctx.storage.get<string>('agentId')) ?? null;
      const status = (await this.ctx.storage.get<string>('status')) ?? 'stopped';
      const analysisInterval = (await this.ctx.storage.get<string>('analysisInterval')) ?? null;
      const nextAlarmAt = (await this.ctx.storage.get<number>('nextAlarmAt')) ?? null;
      const tickCount = (await this.ctx.storage.get<number>('tickCount')) ?? 0;
      const isLoopRunning = (await this.ctx.storage.get<number>('isLoopRunning')) ?? null;
      const lastStopOutAt = (await this.ctx.storage.get<number>('lastStopOutAt')) ?? null;
      const pendingTrade = (await this.ctx.storage.get<unknown>('pendingTrade')) ?? null;
      const engineState = await this.ctx.storage.get<ReturnType<PaperEngine['serialize']>>('engineState');

      // Collect all priceMiss keys
      const priceMissMap: Record<string, number> = {};
      const priceMissKeys = await this.ctx.storage.list<number>({ prefix: 'priceMiss:' });
      for (const [key, val] of priceMissKeys) {
        priceMissMap[key] = val;
      }

      return Response.json({
        agentId,
        status,
        analysisInterval,
        nextAlarmAt,
        tickCount,
        isLoopRunning,
        lastStopOutAt,
        pendingTrade,
        priceMisses: priceMissMap,
        engine: engineState
          ? {
              balance: engineState.balance,
              initialBalance: engineState.initialBalance,
              openPositions: engineState.positions.length,
              closedPositions: engineState.closedPositions?.length ?? 0,
            }
          : null,
        generatedAt: new Date().toISOString(),
      });
    }

    // ── /receive-decision ─────────────────────────────────────────────────────
    // Called by the queue consumer after calling the LLM. Validates the jobId to
    // guard against stale retries, then executes the trade using the saved context.
	    if (url.pathname === '/receive-decision' && request.method === 'POST') {
	      const body = (await request.json().catch(() => ({}))) as { jobId?: string; decision?: unknown };
	      if (!body.jobId || !body.decision) {
	        return Response.json({ error: 'jobId and decision are required' }, { status: 400 });
	      }

      // Idempotency: reject stale results from retried queue messages
      const pendingJobId = await this.ctx.storage.get<string>('pendingLlmJobId');
      if (pendingJobId !== body.jobId) {
        console.warn(`[TradingAgentDO] /receive-decision: stale jobId=${body.jobId} (pending=${pendingJobId})`);
        return Response.json({ ok: true, skipped: true });
      }

      const pendingCtx = await this.ctx.storage.get<PendingLlmContext>('pendingLlmContext');
      if (!pendingCtx) {
        // Context expired (DO was evicted after enqueueing) — clear locks and bail
        await this.ctx.storage.delete('pendingLlmJobId');
        await this.ctx.storage.delete('pendingLlmJobAt');
        return Response.json({ error: 'Pending context expired' }, { status: 410 });
      }

      const agentId = await this.ctx.storage.get<string>('agentId');
      if (!agentId) return Response.json({ error: 'Agent not initialized' }, { status: 400 });

      // Restore engine state
      const engineState = await this.ctx.storage.get<ReturnType<PaperEngine['serialize']>>('engineState');
      const engine = engineState
        ? PaperEngine.deserialize(engineState)
        : new PaperEngine({ balance: 10_000, slippage: 0.3 });

      // Read recent decisions from cache (for updating the cache after the decision)
      const recentDecisions = (await this.ctx.storage.get<RecentDecision[]>('recentDecisions')) ?? [];

      const db = drizzle(this.env.DB);
      const { createLogger } = await import('../lib/logger.js');
      const log = createLogger('agent-loop', agentId);

      try {
        await executeTradeDecision(body.decision as Parameters<typeof executeTradeDecision>[0], {
          agentId,
          engine,
          marketData: pendingCtx.marketData,
          pairsToFetch: pendingCtx.pairsToFetch,
          recentDecisions,
          effectiveLlmModel: pendingCtx.effectiveLlmModel,
          minConfidence: pendingCtx.minConfidence,
          maxOpenPositions: pendingCtx.maxOpenPositions,
          maxPositionSizePct: pendingCtx.maxPositionSizePct,
          dexes: pendingCtx.dexes,
          strategies: pendingCtx.strategies,
          slippageSimulation: pendingCtx.slippageSimulation,
          db,
          ctx: this.ctx,
          log,
        });
      } catch (err) {
        console.error(`[TradingAgentDO] /receive-decision execution error for ${agentId}:`, err);
        // Clear locks even on error so the alarm can proceed on the next tick
        await this.ctx.storage.delete('pendingLlmJobId');
        await this.ctx.storage.delete('pendingLlmJobAt');
        await this.ctx.storage.delete('pendingLlmContext');
        return Response.json({ error: String(err) }, { status: 500 });
      }

      // Persist updated engine state
      try {
        await this.ctx.storage.put('engineState', engine.serialize());
      } catch (err) {
        console.error(`[TradingAgentDO] failed to persist engine after /receive-decision for ${agentId}:`, err);
      }

      // Clear pending job locks
      await this.ctx.storage.delete('pendingLlmJobId');
      await this.ctx.storage.delete('pendingLlmJobAt');
      await this.ctx.storage.delete('pendingLlmContext');

      return Response.json({ ok: true });
    }

    if (url.pathname === '/sync-config' && request.method === 'POST') {
      // Called by the HTTP route layer after a PATCH /api/agents/:id so the DO
      // cache stays fresh without waiting for the next alarm tick.
      const body = (await request.json().catch(() => ({}))) as { agentRow?: CachedAgentRow };
      if (body.agentRow) {
        // Preserve the authoritative status from DO storage — don't let the
        // caller's snapshot override it (the DB status update may race the DO).
        const currentStatus = (await this.ctx.storage.get<string>('status')) ?? 'stopped';
        await this.ctx.storage.put('cachedAgentRow', { ...body.agentRow, status: currentStatus });
      }
      return Response.json({ ok: true });
    }

    // ── WebSocket upgrade ────────────────────────────────────────────────────
    // Incoming request has already been authenticated by the Worker.
    if (url.pathname === '/ws' && request.headers.get('Upgrade') === 'websocket') {
      const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];
      // acceptWebSocket registers the server-side WS for hibernation.
      // Tag with the agentId so broadcasts can filter by agent.
      const agentId = (await this.ctx.storage.get<string>('agentId')) ?? 'unknown';
      this.ctx.acceptWebSocket(server, [`agent:${agentId}`]);
      // Send initial state snapshot
      const engineState = await this.ctx.storage.get<ReturnType<PaperEngine['serialize']>>('engineState');
      const status = (await this.ctx.storage.get<string>('status')) ?? 'stopped';
      server.send(JSON.stringify({
        type: 'snapshot',
        agentId,
        status,
        balance: engineState?.balance ?? null,
        openPositions: engineState?.positions?.length ?? 0,
      }));
      return new Response(null, { status: 101, webSocket: client });
    }

    return new Response('Not Found', { status: 404 });
  }

  /** Broadcast a JSON message to all connected WebSocket clients. */
  private broadcast(message: object): void {
    const json = JSON.stringify(message);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(json);
      } catch {
        // Client WS is closed or errored — CF runtime will clean it up on next poll
      }
    }
  }

  // ── Hibernatable WebSocket handlers ───────────────────────────────────────

  async webSocketMessage(_ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    // Currently no client → server protocol; ignore messages.
    // Could add subscribe/ping support here in future.
    const text = typeof message === 'string' ? message : new TextDecoder().decode(message);
    if (text === 'ping') (_ws as WebSocket).send('pong');
  }

  async webSocketClose(ws: WebSocket, code: number, _reason: string, _wasClean: boolean): Promise<void> {
    ws.close(code, 'Connection closed');
  }

  async webSocketError(_ws: WebSocket, _error: unknown): Promise<void> {
    // CF runtime removes errored WS from getWebSockets() automatically
  }

  async alarm(): Promise<void> {
    const status = (await this.ctx.storage.get<string>('status')) ?? 'stopped';
    if (status !== 'running') return;

    const agentId = await this.ctx.storage.get<string>('agentId');
    if (!agentId) return;

    // Skip if awaiting an async LLM result from the queue (idempotency guard).
    // Stale jobs (>5 min) are auto-cleared in runAgentLoop; don't block here indefinitely.
    const pendingJobAt = await this.ctx.storage.get<number>('pendingLlmJobAt');
    if (pendingJobAt && Date.now() - pendingJobAt < 5 * 60_000) {
      const pendingJobId = await this.ctx.storage.get<string>('pendingLlmJobId');
      console.log(`[TradingAgentDO] ${agentId}: awaiting LLM result for job ${pendingJobId}, skipping alarm tick`);
      await this.rescheduleAlarmIfRunning();
      return;
    }

    // Skip if a manual analyze is already running (stale locks >10min are ignored)
    const LOCK_TTL_MS = 10 * 60_000;
    const lockAt = await this.ctx.storage.get<number>('isLoopRunning');
    if (lockAt && Date.now() - lockAt < LOCK_TTL_MS) {
      console.warn(`[TradingAgentDO] ${agentId}: Loop already running, skipping alarm tick`);
      await this.rescheduleAlarmIfRunning();
      return;
    }
    await this.ctx.storage.put('isLoopRunning', Date.now());

    try {
      // Restore or init engine
      const engineState = await this.ctx.storage.get<ReturnType<PaperEngine['serialize']>>('engineState');
      const engine = engineState
        ? PaperEngine.deserialize(engineState)
        : new PaperEngine({ balance: 10_000, slippage: 0.3 });

      // Run the analysis loop
      try {
        await runAgentLoop(agentId, engine, this.env, this.ctx);
      } catch (err) {
        console.error(`[TradingAgentDO] alarm error for ${agentId}:`, err);
      }

      // Persist updated engine state
      try {
        await this.ctx.storage.put('engineState', engine.serialize());
      } catch (err) {
        console.error(`[TradingAgentDO] failed to persist engine state for ${agentId}:`, err);
      }

      // Save a performance snapshot periodically (every ~6 ticks)
      const tickCount = ((await this.ctx.storage.get<number>('tickCount')) ?? 0) + 1;
      await this.ctx.storage.put('tickCount', tickCount);

      if (tickCount % 6 === 0) {
        await this.savePerformanceSnapshot(agentId, engine);
      }
    } catch (err) {
      console.error(`[TradingAgentDO] unexpected alarm error for ${agentId}:`, err);
    } finally {
      await this.ctx.storage.delete('isLoopRunning');
      // ALWAYS reschedule the alarm if the agent is still running.
      // This must be in a finally block so timeouts / serialization errors
      // cannot leave the agent stuck in "running" with no future alarm.
      try {
        const currentStatus = (await this.ctx.storage.get<string>('status')) ?? 'stopped';
        if (currentStatus === 'running') {
          const interval = (await this.ctx.storage.get<string>('analysisInterval')) ?? '1h';
          const nextAlarmAt = Date.now() + intervalToMs(interval);
          await this.ctx.storage.put('nextAlarmAt', nextAlarmAt);
          await this.ctx.storage.setAlarm(nextAlarmAt);
        }
      } catch (rescheduleErr) {
        console.error(`[TradingAgentDO] CRITICAL: failed to reschedule alarm for ${agentId}:`, rescheduleErr);
      }
    }
  }

  /** Reschedule the next alarm if the agent is still in 'running' status. */
  private async rescheduleAlarmIfRunning(): Promise<void> {
    try {
      const status = (await this.ctx.storage.get<string>('status')) ?? 'stopped';
      if (status === 'running') {
        const interval = (await this.ctx.storage.get<string>('analysisInterval')) ?? '1h';
        const nextAlarmAt = Date.now() + intervalToMs(interval);
        await this.ctx.storage.put('nextAlarmAt', nextAlarmAt);
        await this.ctx.storage.setAlarm(nextAlarmAt);
      }
    } catch (err) {
      console.error(`[TradingAgentDO] CRITICAL: failed to reschedule alarm:`, err);
    }
  }

  private async savePerformanceSnapshot(
    agentId: string,
    engine: PaperEngine
  ): Promise<void> {
    try {
      const db = drizzle(this.env.DB);
      const closed = engine.closedPositions;
      const totalTrades = closed.length;
      const winRate = engine.getWinRate();
      // Use realized P&L only for the snapshot — engine.balance deducts locked capital
      // for open positions which makes P&L look negative when it isn't.
      const realizedPnlUsd = closed.reduce((sum, p) => sum + (p.pnlUsd ?? 0), 0);
      const serialized = engine.serialize();
      const initialBalance = serialized.initialBalance;
      // Balance = cash + open positions at cost (= initial + realized P&L)
      const openAtCost = serialized.positions.reduce((sum, p) => sum + p.amountUsd, 0);
      const balanceAtCost = serialized.balance + openAtCost;
      const totalPnlPct = initialBalance > 0 ? (realizedPnlUsd / initialBalance) * 100 : 0;

      // Simplified Sharpe (assume 0% risk-free, using stddev of pnl pcts)
      let sharpeRatio: number | null = null;
      if (closed.length >= 5) {
        const pnls = closed.map((t) => t.pnlPct ?? 0);
        const mean = pnls.reduce((a, b) => a + b, 0) / pnls.length;
        const variance =
          pnls.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / pnls.length;
        const stddev = Math.sqrt(variance);
        sharpeRatio = stddev > 0 ? mean / stddev : 0;
      }

      // Max drawdown from closed trades
      let maxDrawdown: number | null = null;
      if (closed.length >= 2) {
        let peak = 0;
        let drawdown = 0;
        let cumPnl = 0;
        for (const t of closed) {
          cumPnl += t.pnlPct ?? 0;
          if (cumPnl > peak) peak = cumPnl;
          const dd = peak - cumPnl;
          if (dd > drawdown) drawdown = dd;
        }
        maxDrawdown = drawdown;
      }

      await db.insert(performanceSnapshots).values({
        id: generateId('snap'),
        agentId,
        balance: balanceAtCost,
        totalPnlPct,
        winRate,
        totalTrades,
        sharpeRatio,
        maxDrawdown,
        snapshotAt: nowIso(),
      });
    } catch (err) {
      console.warn(`[TradingAgentDO] Failed to save snapshot:`, err);
    }
  }

  private async persistTrade(position: Position): Promise<void> {
    const db = drizzle(this.env.DB);
    await db
      .insert(trades)
      .values({
        id: position.id,
        agentId: position.agentId,
        pair: position.pair,
        dex: position.dex,
        side: position.side,
        entryPrice: position.entryPrice,
        exitPrice: position.exitPrice ?? null,
        amountUsd: position.amountUsd,
        pnlPct: position.pnlPct ?? null,
        pnlUsd: position.pnlUsd ?? null,
        confidenceBefore: position.confidenceBefore,
        confidenceAfter: position.confidenceAfter ?? null,
        reasoning: position.reasoning,
        strategyUsed: position.strategyUsed,
        slippageSimulated: position.slippageSimulated,
        status: position.status,
        closeReason: position.closeReason ?? null,
        openedAt: position.openedAt,
        closedAt: position.closedAt ?? null,
      })
      .onConflictDoUpdate({
        target: trades.id,
        set: {
          exitPrice: position.exitPrice ?? null,
          pnlPct: position.pnlPct ?? null,
          pnlUsd: position.pnlUsd ?? null,
          confidenceAfter: position.confidenceAfter ?? null,
          status: position.status,
          closeReason: position.closeReason ?? null,
          closedAt: position.closedAt ?? null,
        },
      });
  }
}
