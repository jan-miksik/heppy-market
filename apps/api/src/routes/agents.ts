import { Hono } from 'hono';
import { drizzle } from 'drizzle-orm/d1';
import { eq, desc, or, isNull } from 'drizzle-orm';
import type { Env } from '../types/env.js';
import type { AuthVariables } from '../lib/auth.js';
import { agents, trades, agentDecisions, performanceSnapshots, agentSelfModifications, users } from '../db/schema.js';
import { BASE_AGENT_PROMPT, buildAnalysisPrompt } from '../agents/prompts.js';
import { buildJsonSchemaInstruction } from '../services/llm-router.js';
import {
  CreateAgentRequestSchema,
  DEFAULT_FREE_AGENT_MODEL,
  DEFAULT_AGENT_PROFILE_ID,
  InitiaLinkRequestSchema,
  InitiaSyncRequestSchema,
  UpdateAgentRequestSchema,
  UpdatePersonaSchema,
  getAgentPersonaTemplate,
  getDefaultAgentPersona,
  resolveAgentProfileId,
} from '@something-in-loop/shared';
import { validateBody, ValidationError } from '../lib/validation.js';
import { generateId, nowIso } from '../lib/utils.js';
import { normalizePairsForDex } from '../lib/pairs.js';
import { resolveAgentPersonaMd } from '../agents/resolve-agent-persona.js';
import {
  pauseTradingAgentDo,
  registerSchedulerAgent,
  setTradingAgentIntervalDo,
  startTradingAgentDo,
  stopTradingAgentDo,
  syncTradingAgentConfigDo,
  unregisterSchedulerAgent,
} from '../lib/do-clients.js';

const agentsRoute = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

/** Best-effort: register or unregister an agent with the global scheduler DO.
 *  Uses idFromName('scheduler') — one global instance shared across all cron ticks.
 *  Failures are logged but never bubble up to the caller. */
async function notifyScheduler(
  env: Env,
  action: 'register' | 'unregister',
  agentId: string,
  interval?: string
): Promise<void> {
  try {
    if (action === 'register') {
      await registerSchedulerAgent(env, { agentId, interval: interval ?? '1h' });
    } else {
      await unregisterSchedulerAgent(env, agentId);
    }
  } catch (err) {
    console.warn(`[agents route] scheduler ${action} failed for ${agentId}:`, err);
  }
}

function formatAgent(r: typeof agents.$inferSelect) {
  let initiaSyncState: Record<string, unknown> | null = null;
  if (r.initiaSyncState) {
    try {
      initiaSyncState = JSON.parse(r.initiaSyncState) as Record<string, unknown>;
    } catch {
      initiaSyncState = null;
    }
  }
  return {
    ...r,
    config: JSON.parse(r.config),
    initiaSyncState,
  };
}

function normalizeInitiaWalletAddress(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.toLowerCase();
}

function parseInitiaSyncState(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return typeof parsed === 'object' && parsed ? parsed : {};
  } catch {
    return {};
  }
}

/** GET /api/agents — list agents owned by the authenticated user (+ legacy unowned) */
agentsRoute.get('/', async (c) => {
  const walletAddress = c.get('walletAddress');
  const db = drizzle(c.env.DB);
  const rows = await db
    .select()
    .from(agents)
    .where(or(eq(agents.ownerAddress, walletAddress), isNull(agents.ownerAddress)))
    .orderBy(desc(agents.createdAt));
  return c.json({ agents: rows.map(formatAgent) });
});

/** POST /api/agents — create agent, scoped to authenticated user */
agentsRoute.post('/', async (c) => {
  const body = await validateBody(c, CreateAgentRequestSchema);
  const walletAddress = c.get('walletAddress');
  const db = drizzle(c.env.DB);

  const chain = body.chain ?? 'base';
  const initiaWalletAddress = normalizeInitiaWalletAddress(body.initiaWalletAddress);

  const id = generateId('agent');
  const now = nowIso();
  const config = {
    ...body,
    ...(typeof body.profileId === 'string' && { profileId: resolveAgentProfileId(body.profileId) }),
    pairs: normalizePairsForDex(body.pairs),
  };

  const profileId = typeof body.profileId === 'string' ? resolveAgentProfileId(body.profileId) : null;

  await db.insert(agents).values({
    id,
    name: body.name,
    status: 'stopped',
    autonomyLevel: 2,
    chain,
    config: JSON.stringify(config),
    llmModel: body.llmModel,
    ownerAddress: walletAddress,
    profileId,
    personaMd: body.personaMd ?? null,
    initiaWalletAddress: chain === 'initia' ? initiaWalletAddress : null,
    initiaMetadataHash: body.initiaMetadataHash ?? null,
    initiaMetadataVersion: body.initiaMetadataVersion ?? null,
    createdAt: now,
    updatedAt: now,
  });

  const [created] = await db.select().from(agents).where(eq(agents.id, id));
  return c.json(formatAgent(created), 201);
});

/** Shared ownership check: owns or legacy unowned */
async function requireOwnership(
  db: ReturnType<typeof drizzle>,
  id: string,
  walletAddress: string
): Promise<typeof agents.$inferSelect | null> {
  const [agent] = await db.select().from(agents).where(eq(agents.id, id));
  if (!agent) return null;
  if (agent.ownerAddress && agent.ownerAddress !== walletAddress) return null;
  return agent;
}

/** GET /api/agents/:id — get single agent */
agentsRoute.get('/:id', async (c) => {
  const id = c.req.param('id');
  const walletAddress = c.get('walletAddress');
  const db = drizzle(c.env.DB);

  const agent = await requireOwnership(db, id, walletAddress);
  if (!agent) return c.json({ error: 'Agent not found' }, 404);

  return c.json(formatAgent(agent));
});

/** PATCH /api/agents/:id — update agent config */
agentsRoute.patch('/:id', async (c) => {
  const id = c.req.param('id');
  const walletAddress = c.get('walletAddress');
  const body = await validateBody(c, UpdateAgentRequestSchema);
  const db = drizzle(c.env.DB);

  const existing = await requireOwnership(db, id, walletAddress);
  if (!existing) return c.json({ error: 'Agent not found' }, 404);

  // Optional optimistic lock: client passes the updatedAt it last saw
  const clientVersion = typeof (body as any)._version === 'string' ? (body as any)._version : null;
  if (clientVersion && existing.updatedAt !== clientVersion) {
    return c.json(
      { error: 'Conflict: agent was modified by another request. Reload and retry.', code: 'VERSION_CONFLICT' },
      409
    );
  }

  const existingConfig = JSON.parse(existing.config);
  const existingChain = existing.chain ?? ((existingConfig as { chain?: string }).chain ?? 'base');
  const nextChain = typeof body.chain === 'string' ? body.chain : existingChain;
  const nextInitiaWalletAddress = body.initiaWalletAddress !== undefined
    ? normalizeInitiaWalletAddress(body.initiaWalletAddress)
    : normalizeInitiaWalletAddress(existing.initiaWalletAddress);

  const mergedConfig = {
    ...existingConfig,
    ...body,
    chain: nextChain,
    ...(nextInitiaWalletAddress ? { initiaWalletAddress: nextInitiaWalletAddress } : {}),
    ...(typeof body.profileId === 'string' && { profileId: resolveAgentProfileId(body.profileId) }),
    ...(body.pairs !== undefined && { pairs: normalizePairsForDex(body.pairs) }),
  };

  const prevInterval = (existingConfig as any).analysisInterval;
  const nextInterval = (mergedConfig as any).analysisInterval;
  const intervalChanged =
    typeof nextInterval === 'string' &&
    nextInterval.trim().length > 0 &&
    nextInterval !== prevInterval;

  const updates: Partial<typeof agents.$inferInsert> = {
    chain: nextChain,
    config: JSON.stringify(mergedConfig),
    updatedAt: nowIso(),
  };
  if (body.name) updates.name = body.name;
  // Always sync llm_model column from merged config so the agent loop uses the selected model
  updates.llmModel = (mergedConfig.llmModel ?? existing.llmModel) || DEFAULT_FREE_AGENT_MODEL;
  if (body.profileId !== undefined) {
    updates.profileId = typeof body.profileId === 'string' ? resolveAgentProfileId(body.profileId) : body.profileId ?? null;
  }
  if (body.personaMd !== undefined) updates.personaMd = body.personaMd ?? null;
  if (body.initiaWalletAddress !== undefined) updates.initiaWalletAddress = nextInitiaWalletAddress;
  if (body.initiaMetadataHash !== undefined) updates.initiaMetadataHash = body.initiaMetadataHash ?? null;
  if (body.initiaMetadataVersion !== undefined) updates.initiaMetadataVersion = body.initiaMetadataVersion ?? null;

  await db.update(agents).set(updates).where(eq(agents.id, id));

  const [updated] = await db.select().from(agents).where(eq(agents.id, id));

  // Best-effort: push updated config to the DO cache so runAgentLoop picks it up
  // immediately without waiting for the next cache miss.
  if (updated) {
    try {
      await syncTradingAgentConfigDo(c.env, id, {
        id: updated.id,
        name: updated.name,
        status: updated.status,
        config: updated.config,
        ownerAddress: updated.ownerAddress ?? null,
        llmModel: updated.llmModel ?? null,
        profileId: updated.profileId ?? null,
        personaMd: updated.personaMd ?? null,
      });
    } catch (err) {
      console.warn(`[agents route] Failed to push config to TRADING_AGENT DO cache for ${id}:`, err);
    }
  }

  // Best-effort: if the agent is currently running, sync the DO alarm interval immediately.
  if (intervalChanged && existing.status === 'running') {
    try {
      await setTradingAgentIntervalDo(c.env, id, String(nextInterval));
    } catch (err) {
      console.warn(`[agents route] Failed to sync analysisInterval to TRADING_AGENT DO for ${id}:`, err);
    }
    // Also update the scheduler registry with the new interval
    await notifyScheduler(c.env, 'register', id, nextInterval);
  }
  return c.json({
    ...formatAgent(updated),
    pendingRestart: existing.status === 'running',
  });
});

/** POST /api/agents/:id/initia/link — attach onchain link metadata */
agentsRoute.post('/:id/initia/link', async (c) => {
  const id = c.req.param('id');
  const walletAddress = c.get('walletAddress');
  const body = await validateBody(c, InitiaLinkRequestSchema);
  const db = drizzle(c.env.DB);

  const existing = await requireOwnership(db, id, walletAddress);
  if (!existing) return c.json({ error: 'Agent not found' }, 404);
  if (existing.chain !== 'initia') {
    return c.json({ error: 'Initia link is only supported for Initia agents.' }, 400);
  }

  const initiaWalletAddress = normalizeInitiaWalletAddress(body.initiaWalletAddress);
  if (!initiaWalletAddress) {
    return c.json({ error: 'Invalid Initia wallet address.' }, 400);
  }

  const now = nowIso();
  const currentSync = parseInitiaSyncState(existing.initiaSyncState);
  const mergedSync = {
    ...currentSync,
    walletAddress: initiaWalletAddress,
    evmAddress: body.evmAddress ?? currentSync.evmAddress ?? null,
    linkTxHash: body.txHash,
    metadataPointer: body.metadataPointer,
  };

  await db
    .update(agents)
    .set({
      initiaWalletAddress,
      initiaMetadataHash: body.metadataPointer.configHash,
      initiaMetadataVersion: body.metadataPointer.version,
      initiaLinkTxHash: body.txHash,
      initiaLinkedAt: now,
      initiaSyncState: JSON.stringify(mergedSync),
      initiaLastSyncedAt: now,
      updatedAt: now,
    })
    .where(eq(agents.id, id));

  const [updated] = await db.select().from(agents).where(eq(agents.id, id));
  return c.json(formatAgent(updated));
});

/** POST /api/agents/:id/initia/sync — persist latest wallet/onchain snapshot */
agentsRoute.post('/:id/initia/sync', async (c) => {
  const id = c.req.param('id');
  const walletAddress = c.get('walletAddress');
  const body = await validateBody(c, InitiaSyncRequestSchema);
  const db = drizzle(c.env.DB);

  const existing = await requireOwnership(db, id, walletAddress);
  if (!existing) return c.json({ error: 'Agent not found' }, 404);
  if (existing.chain !== 'initia') {
    return c.json({ error: 'Initia sync is only supported for Initia agents.' }, 400);
  }

  const normalizedWalletAddress = normalizeInitiaWalletAddress(body.state.walletAddress);

  const now = nowIso();
  const currentSync = parseInitiaSyncState(existing.initiaSyncState);
  const mergedSync = {
    ...currentSync,
    ...body.state,
    ...(normalizedWalletAddress ? { walletAddress: normalizedWalletAddress } : {}),
  };

  const updates: Partial<typeof agents.$inferInsert> = {
    initiaSyncState: JSON.stringify(mergedSync),
    initiaLastSyncedAt: now,
    updatedAt: now,
  };
  if (normalizedWalletAddress) updates.initiaWalletAddress = normalizedWalletAddress;

  await db.update(agents).set(updates).where(eq(agents.id, id));

  return c.json({ ok: true, state: mergedSync, syncedAt: now });
});

/** GET /api/agents/:id/initia/status */
agentsRoute.get('/:id/initia/status', async (c) => {
  const id = c.req.param('id');
  const walletAddress = c.get('walletAddress');
  const db = drizzle(c.env.DB);

  const existing = await requireOwnership(db, id, walletAddress);
  if (!existing) return c.json({ error: 'Agent not found' }, 404);
  if (existing.chain !== 'initia') {
    return c.json({ error: 'Initia status is only available for Initia agents.' }, 400);
  }

  const state = parseInitiaSyncState(existing.initiaSyncState);
  return c.json({
    agentId: existing.id,
    chain: existing.chain,
    initiaWalletAddress: existing.initiaWalletAddress,
    metadataHash: existing.initiaMetadataHash,
    metadataVersion: existing.initiaMetadataVersion,
    linkTxHash: existing.initiaLinkTxHash,
    linkedAt: existing.initiaLinkedAt,
    lastSyncedAt: existing.initiaLastSyncedAt,
    state,
  });
});

/** DELETE /api/agents/:id — delete agent (stops first if running) */
agentsRoute.delete('/:id', async (c) => {
  const id = c.req.param('id');
  const walletAddress = c.get('walletAddress');
  const db = drizzle(c.env.DB);

  const existing = await requireOwnership(db, id, walletAddress);
  if (!existing) return c.json({ error: 'Agent not found' }, 404);

  if (existing.status === 'running' || existing.status === 'paused') {
    try {
      await stopTradingAgentDo(c.env, id);
    } catch (err) {
      console.error('[agents route] Failed to stop TRADING_AGENT DO before delete', err);
    }
    await db.update(agents).set({ status: 'stopped', updatedAt: nowIso() }).where(eq(agents.id, id));
  }

  await notifyScheduler(c.env, 'unregister', id);

  await db.delete(trades).where(eq(trades.agentId, id));
  await db.delete(agentDecisions).where(eq(agentDecisions.agentId, id));
  await db.delete(performanceSnapshots).where(eq(performanceSnapshots.agentId, id));
  await db.delete(agentSelfModifications).where(eq(agentSelfModifications.agentId, id));
  await db.delete(agents).where(eq(agents.id, id));
  return c.json({ ok: true });
});

/** POST /api/agents/:id/start — start agent */
agentsRoute.post('/:id/start', async (c) => {
  const id = c.req.param('id');
  const walletAddress = c.get('walletAddress');
  const db = drizzle(c.env.DB);

  const agent = await requireOwnership(db, id, walletAddress);
  if (!agent) return c.json({ error: 'Agent not found' }, 404);

  if (agent.status === 'running') {
    return c.json({ ok: true, status: 'running', message: 'Already running' });
  }

  const agentConfig = JSON.parse(agent.config) as {
    paperBalance: number;
    slippageSimulation: number;
    analysisInterval: string;
  };
  await startTradingAgentDo(c.env, {
    agentId: id,
    paperBalance: agentConfig.paperBalance,
    slippageSimulation: agentConfig.slippageSimulation,
    analysisInterval: agentConfig.analysisInterval,
    agentRow: {
      id: agent.id,
      name: agent.name,
      status: 'running', // will be set running momentarily
      config: agent.config,
      ownerAddress: agent.ownerAddress ?? null,
      llmModel: agent.llmModel ?? null,
      profileId: agent.profileId ?? null,
      personaMd: agent.personaMd ?? null,
    },
  });

  await db.update(agents).set({ status: 'running', updatedAt: nowIso() }).where(eq(agents.id, id));

  // Register with global scheduler so cron handler doesn't need to scan D1
  await notifyScheduler(c.env, 'register', id, agentConfig.analysisInterval ?? '1h');

  return c.json({ ok: true, status: 'running' });
});

/** POST /api/agents/:id/reset */
agentsRoute.post('/:id/reset', async (c) => {
  const id = c.req.param('id');
  const walletAddress = c.get('walletAddress');
  const db = drizzle(c.env.DB);

  const agent = await requireOwnership(db, id, walletAddress);
  if (!agent) return c.json({ error: 'Agent not found' }, 404);

  const config = JSON.parse(agent.config) as { paperBalance?: number; slippageSimulation?: number };
  const doId = c.env.TRADING_AGENT.idFromName(id);
  const stub = c.env.TRADING_AGENT.get(doId);
  await stub.fetch(
    new Request('http://do/reset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paperBalance: config.paperBalance, slippageSimulation: config.slippageSimulation }),
    })
  );

  await db.update(agents).set({ status: 'stopped', updatedAt: nowIso() }).where(eq(agents.id, id));
  return c.json({ ok: true, message: 'Agent reset to initial paper balance' });
});

/** POST /api/agents/:id/stop */
agentsRoute.post('/:id/stop', async (c) => {
  const id = c.req.param('id');
  const walletAddress = c.get('walletAddress');
  const db = drizzle(c.env.DB);

  const agent = await requireOwnership(db, id, walletAddress);
  if (!agent) return c.json({ error: 'Agent not found' }, 404);

  await stopTradingAgentDo(c.env, id);
  await db.update(agents).set({ status: 'stopped', updatedAt: nowIso() }).where(eq(agents.id, id));

  await notifyScheduler(c.env, 'unregister', id);

  return c.json({ ok: true, status: 'stopped' });
});

/** POST /api/agents/:id/pause */
agentsRoute.post('/:id/pause', async (c) => {
  const id = c.req.param('id');
  const walletAddress = c.get('walletAddress');
  const db = drizzle(c.env.DB);

  const agent = await requireOwnership(db, id, walletAddress);
  if (!agent) return c.json({ error: 'Agent not found' }, 404);

  await pauseTradingAgentDo(c.env, id);
  await db.update(agents).set({ status: 'paused', updatedAt: nowIso() }).where(eq(agents.id, id));

  await notifyScheduler(c.env, 'unregister', id);

  return c.json({ ok: true, status: 'paused' });
});

/** GET /api/agents/:id/trades */
agentsRoute.get('/:id/trades', async (c) => {
  const id = c.req.param('id');
  const walletAddress = c.get('walletAddress');
  const db = drizzle(c.env.DB);

  const agent = await requireOwnership(db, id, walletAddress);
  if (!agent) return c.json({ error: 'Agent not found' }, 404);

  const agentTrades = await db
    .select()
    .from(trades)
    .where(eq(trades.agentId, id))
    .orderBy(desc(trades.openedAt));
  return c.json({ trades: agentTrades });
});

/** GET /api/agents/:id/decisions */
agentsRoute.get('/:id/decisions', async (c) => {
  const id = c.req.param('id');
  const walletAddress = c.get('walletAddress');
  const db = drizzle(c.env.DB);

  const agent = await requireOwnership(db, id, walletAddress);
  if (!agent) return c.json({ error: 'Agent not found' }, 404);

  const decisions = await db
    .select()
    .from(agentDecisions)
    .where(eq(agentDecisions.agentId, id))
    .orderBy(desc(agentDecisions.createdAt));
  return c.json({ decisions });
});

/** GET /api/agents/:id/performance */
agentsRoute.get('/:id/performance', async (c) => {
  const id = c.req.param('id');
  const walletAddress = c.get('walletAddress');
  const db = drizzle(c.env.DB);

  const agent = await requireOwnership(db, id, walletAddress);
  if (!agent) return c.json({ error: 'Agent not found' }, 404);

  const snapshots = await db
    .select()
    .from(performanceSnapshots)
    .where(eq(performanceSnapshots.agentId, id))
    .orderBy(desc(performanceSnapshots.snapshotAt));
  return c.json({ snapshots });
});

/** POST /api/agents/:id/history/clear — delete all trading history for this agent */
agentsRoute.post('/:id/history/clear', async (c) => {
  const id = c.req.param('id');
  const walletAddress = c.get('walletAddress');
  const db = drizzle(c.env.DB);

  const agent = await requireOwnership(db, id, walletAddress);
  if (!agent) return c.json({ error: 'Agent not found' }, 404);

  // Clear Durable Object engine state first to avoid "phantom" open positions lingering in memory.
  try {
    const agentConfig = JSON.parse(agent.config) as {
      paperBalance?: number;
      slippageSimulation?: number;
      analysisInterval?: string;
    };
    const doId = c.env.TRADING_AGENT.idFromName(id);
    const stub = c.env.TRADING_AGENT.get(doId);
    const res = await stub.fetch(
      new Request('http://do/clear-history', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agentId: id,
          paperBalance: agentConfig.paperBalance,
          slippageSimulation: agentConfig.slippageSimulation,
          analysisInterval: agentConfig.analysisInterval,
        }),
      })
    );
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      return c.json({ error: body?.error ?? 'Failed to clear agent engine state' }, 500);
    }
  } catch (err) {
    return c.json({ error: `Failed to clear agent engine state: ${String(err)}` }, 500);
  }

  await db.delete(trades).where(eq(trades.agentId, id));
  await db.delete(agentDecisions).where(eq(agentDecisions.agentId, id));
  await db.delete(performanceSnapshots).where(eq(performanceSnapshots.agentId, id));
  await db.delete(agentSelfModifications).where(eq(agentSelfModifications.agentId, id));

  return c.json({ ok: true });
});

/** POST /api/agents/:id/analyze */
agentsRoute.post('/:id/analyze', async (c) => {
  const id = c.req.param('id');
  const walletAddress = c.get('walletAddress');
  const db = drizzle(c.env.DB);

  const agent = await requireOwnership(db, id, walletAddress);
  if (!agent) return c.json({ error: 'Agent not found' }, 404);

  if (!c.env.OPENROUTER_API_KEY) {
    return c.json(
      { error: 'OPENROUTER_API_KEY is not configured. Add it to .dev.vars (local) or Cloudflare secrets (production).' },
      503
    );
  }

  const agentConfig = JSON.parse(agent.config) as {
    paperBalance: number;
    slippageSimulation: number;
    analysisInterval: string;
  };
  const doId = c.env.TRADING_AGENT.idFromName(id);
  const stub = c.env.TRADING_AGENT.get(doId);

  const res = await stub.fetch(
    new Request('http://do/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agentId: id,
        paperBalance: agentConfig.paperBalance,
        slippageSimulation: agentConfig.slippageSimulation,
        analysisInterval: agentConfig.analysisInterval,
      }),
    })
  );

  if (!res.ok) {
    const body = await res.json<{ error?: string }>();
    // Preserve 409 (lock contention) — don't flatten all DO errors to 500
    const status = res.status === 409 ? 409 : 500;
    return c.json({ error: body.error ?? 'Analysis failed' }, status);
  }
  return c.json({ ok: true });
});

/** GET /api/agents/:id/debug — returns DO internal state (tester/admin only) */
agentsRoute.get('/:id/debug', async (c) => {
  const id = c.req.param('id');
  const walletAddress = c.get('walletAddress');
  const db = drizzle(c.env.DB);

  const agent = await requireOwnership(db, id, walletAddress);
  if (!agent) return c.json({ error: 'Agent not found' }, 404);

  // Gate to tester role
  const [ownerUser] = await db
    .select({ role: users.role })
    .from(users)
    .where(eq(users.walletAddress, walletAddress));
  if (ownerUser?.role !== 'tester') {
    return c.json({ error: 'Forbidden: debug endpoint requires tester role' }, 403);
  }

  const doId = c.env.TRADING_AGENT.idFromName(id);
  const stub = c.env.TRADING_AGENT.get(doId);
  const res = await stub.fetch(new Request('http://do/debug'));
  if (!res.ok) {
    return c.json({ error: 'Failed to fetch debug state from agent' }, 502);
  }
  const debugState = await res.json();
  return c.json(debugState);
});

/** GET /api/agents/:id/status */
agentsRoute.get('/:id/status', async (c) => {
  const id = c.req.param('id');
  const walletAddress = c.get('walletAddress');
  const db = drizzle(c.env.DB);

  const agent = await requireOwnership(db, id, walletAddress);
  if (!agent) return c.json({ error: 'Agent not found' }, 404);

  const doId = c.env.TRADING_AGENT.idFromName(id);
  const stub = c.env.TRADING_AGENT.get(doId);
  const res = await stub.fetch(new Request('http://do/status'));
  const doStatus = await res.json<{
    agentId: string | null;
    status: string;
    balance: number | null;
    nextAlarmAt: number | null;
  }>();
  return c.json(doStatus);
});

/** GET /api/agents/:id/persona */
agentsRoute.get('/:id/persona', async (c) => {
  const id = c.req.param('id');
  const walletAddress = c.get('walletAddress');
  const db = drizzle(c.env.DB);
  const agent = await requireOwnership(db, id, walletAddress);
  if (!agent) return c.json({ error: 'Agent not found' }, 404);
  return c.json({ personaMd: agent.personaMd ?? null, profileId: agent.profileId ?? null });
});

/** PUT /api/agents/:id/persona */
agentsRoute.put('/:id/persona', async (c) => {
  const id = c.req.param('id');
  const walletAddress = c.get('walletAddress');
  const body = await validateBody(c, UpdatePersonaSchema);
  const db = drizzle(c.env.DB);
  const agent = await requireOwnership(db, id, walletAddress);
  if (!agent) return c.json({ error: 'Agent not found' }, 404);
  await db.update(agents).set({ personaMd: body.personaMd, updatedAt: nowIso() }).where(eq(agents.id, id));
  return c.json({ ok: true, personaMd: body.personaMd });
});

/** POST /api/agents/:id/persona/reset */
agentsRoute.post('/:id/persona/reset', async (c) => {
  const id = c.req.param('id');
  const walletAddress = c.get('walletAddress');
  const db = drizzle(c.env.DB);
  const agent = await requireOwnership(db, id, walletAddress);
  if (!agent) return c.json({ error: 'Agent not found' }, 404);
  const config = JSON.parse(agent.config) as { profileId?: string };
  const profileId = config.profileId ?? agent.profileId ?? DEFAULT_AGENT_PROFILE_ID;
  const personaMd = getAgentPersonaTemplate(profileId, agent.name);
  await db.update(agents).set({ personaMd, updatedAt: nowIso() }).where(eq(agents.id, id));
  return c.json({ ok: true, personaMd });
});

/** GET /api/agents/:id/prompt-preview — build the full prompt from last market snapshot */
agentsRoute.get('/:id/prompt-preview', async (c) => {
  const id = c.req.param('id');
  const walletAddress = c.get('walletAddress');
  const db = drizzle(c.env.DB);

  const agent = await requireOwnership(db, id, walletAddress);
  if (!agent) return c.json({ error: 'Agent not found' }, 404);

  const config = JSON.parse(agent.config) as Record<string, unknown>;

  const [lastDecision] = await db
    .select()
    .from(agentDecisions)
    .where(eq(agentDecisions.agentId, id))
    .orderBy(desc(agentDecisions.createdAt))
    .limit(1);

  const rawMarketData = lastDecision?.marketDataSnapshot
    ? JSON.parse(lastDecision.marketDataSnapshot) as Array<{
        pair: string; priceUsd: number; priceChange: Record<string, number | undefined>;
        volume24h?: number; liquidity?: number; indicatorText: string;
      }>
    : [];

  const recentDecisions = await db
    .select({ decision: agentDecisions.decision, confidence: agentDecisions.confidence, createdAt: agentDecisions.createdAt })
    .from(agentDecisions)
    .where(eq(agentDecisions.agentId, id))
    .orderBy(desc(agentDecisions.createdAt))
    .limit(10);

  const allTrades = await db.select().from(trades).where(eq(trades.agentId, id));
  const openTrades = allTrades.filter((t) => t.status === 'open');
  const closedTrades = allTrades.filter((t) => t.status !== 'open');

  // Enrich open positions with current price + unrealized P&L using the latest market snapshot
  const openPositions = openTrades.map((t) => {
    const m = rawMarketData.find((entry) => entry.pair === t.pair);
    const currentPrice = m?.priceUsd && m.priceUsd > 0 ? m.priceUsd : t.entryPrice;
    const unrealizedPct =
      m && m.priceUsd > 0
        ? (t.side === 'buy'
            ? ((currentPrice - t.entryPrice) / t.entryPrice) * 100
            : ((t.entryPrice - currentPrice) / t.entryPrice) * 100)
        : 0;

    return {
      pair: t.pair,
      side: t.side as 'buy' | 'sell',
      entryPrice: t.entryPrice,
      amountUsd: t.amountUsd,
      unrealizedPct,
      currentPrice,
      openedAt: t.openedAt,
      slPct: (config.stopLossPct as number) ?? 5,
      tpPct: (config.takeProfitPct as number) ?? 7,
    };
  });

  const paperBalance = (config.paperBalance as number) ?? 10000;

  // Approximate portfolio P&L from trades + latest prices
  const realizedPnlUsd = closedTrades.reduce((sum, t) => sum + (t.pnlUsd ?? 0), 0);
  const unrealizedPnlUsd = openPositions.reduce(
    (sum, p) => sum + ((p.unrealizedPct / 100) * p.amountUsd),
    0
  );
  const totalPnlUsd = realizedPnlUsd + unrealizedPnlUsd;
  const totalPnlPct = paperBalance > 0 ? (totalPnlUsd / paperBalance) * 100 : 0;

  const systemPrompt = BASE_AGENT_PROMPT + buildJsonSchemaInstruction();
  const personaMd = resolveAgentPersonaMd({
    agentName: agent.name,
    agentPersonaMd: agent.personaMd,
    agentProfileId: agent.profileId,
    config,
  });
  const userPrompt = rawMarketData.length > 0
    ? buildAnalysisPrompt({
        portfolioState: {
          balance: paperBalance + totalPnlUsd,
          openPositions: openPositions.length,
          dailyPnlPct: 0,
          totalPnlPct,
        },
        openPositions,
        marketData: rawMarketData,
        lastDecisions: recentDecisions,
        config: {
          pairs: (config.pairs as string[]) ?? [],
          maxPositionSizePct: (config.maxPositionSizePct as number) ?? 5,
          maxOpenPositions: (config.maxOpenPositions as number) ?? 3,
          stopLossPct: (config.stopLossPct as number) ?? 5,
          takeProfitPct: (config.takeProfitPct as number) ?? 7,
        },
        behavior: config.behavior as any,
        personaMd,
        behaviorMd: (config.behaviorMd as string | undefined) ?? null,
        roleMd: (config.roleMd as string | undefined) ?? null,
      })
    : '(No market data yet — run the agent at least once to populate the preview)';

  return c.json({
    systemPrompt,
    userPrompt,
    marketDataAt: lastDecision?.createdAt ?? null,
    hasMarketData: rawMarketData.length > 0,
  });
});



/** GET /api/agents/:id/self-modifications */
agentsRoute.get('/:id/self-modifications', async (c) => {
  const id = c.req.param('id');
  const walletAddress = c.get('walletAddress');
  const db = drizzle(c.env.DB);

  const agent = await requireOwnership(db, id, walletAddress);
  if (!agent) return c.json({ error: 'Agent not found' }, 404);

  const modifications = await db
    .select()
    .from(agentSelfModifications)
    .where(eq(agentSelfModifications.agentId, id))
    .orderBy(desc(agentSelfModifications.createdAt));

  return c.json({
    modifications: modifications.map((m) => ({
      ...m,
      changes: JSON.parse(m.changes),
      changesApplied: m.changesApplied ? JSON.parse(m.changesApplied) : null,
    })),
  });
});

/** POST /api/agents/:id/self-modifications/:modId/approve */
agentsRoute.post('/:id/self-modifications/:modId/approve', async (c) => {
  const id = c.req.param('id');
  const modId = c.req.param('modId');
  const walletAddress = c.get('walletAddress');
  const db = drizzle(c.env.DB);

  const agent = await requireOwnership(db, id, walletAddress);
  if (!agent) return c.json({ error: 'Agent not found' }, 404);

  const [mod] = await db
    .select()
    .from(agentSelfModifications)
    .where(eq(agentSelfModifications.id, modId));
  if (!mod || mod.agentId !== id) return c.json({ error: 'Modification not found' }, 404);

  const changes = JSON.parse(mod.changes) as Record<string, unknown>;
  const existingConfig = JSON.parse(agent.config) as Record<string, unknown>;
  const mergedConfig = { ...existingConfig, ...changes };

  await db.update(agents).set({ config: JSON.stringify(mergedConfig), updatedAt: nowIso() }).where(eq(agents.id, id));
  await db
    .update(agentSelfModifications)
    .set({ status: 'applied', changesApplied: mod.changes, appliedAt: nowIso() })
    .where(eq(agentSelfModifications.id, modId));

  return c.json({ ok: true });
});

/** POST /api/agents/:id/self-modifications/:modId/reject */
agentsRoute.post('/:id/self-modifications/:modId/reject', async (c) => {
  const id = c.req.param('id');
  const modId = c.req.param('modId');
  const walletAddress = c.get('walletAddress');
  const db = drizzle(c.env.DB);

  const agent = await requireOwnership(db, id, walletAddress);
  if (!agent) return c.json({ error: 'Agent not found' }, 404);

  const [mod] = await db
    .select()
    .from(agentSelfModifications)
    .where(eq(agentSelfModifications.id, modId));
  if (!mod || mod.agentId !== id) return c.json({ error: 'Modification not found' }, 404);

  await db
    .update(agentSelfModifications)
    .set({ status: 'rejected' })
    .where(eq(agentSelfModifications.id, modId));

  return c.json({ ok: true });
});

// Error handler
agentsRoute.onError((err, c) => {
  if (err instanceof ValidationError) {
    console.error('[agents route] ValidationError', {
      path: c.req.path,
      method: c.req.method,
      fieldErrors: err.fieldErrors ?? null,
    });
    return c.json({ error: err.message, fieldErrors: err.fieldErrors }, 400);
  }
  console.error('[agents route]', err);
  return c.json({ error: 'Internal server error' }, 500);
});

export default agentsRoute;
