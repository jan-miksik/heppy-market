import { Hono } from 'hono';
import { drizzle } from 'drizzle-orm/d1';
import { eq, desc, or, isNull } from 'drizzle-orm';
import type { Env } from '../types/env.js';
import type { AuthVariables } from '../lib/auth.js';
import { agents, trades, agentDecisions, performanceSnapshots, agentSelfModifications } from '../db/schema.js';
import { BASE_AGENT_PROMPT, buildAnalysisPrompt } from '../agents/prompts.js';
import { JSON_SCHEMA_INSTRUCTION } from '../services/llm-router.js';
import { CreateAgentRequestSchema, UpdateAgentRequestSchema, UpdatePersonaSchema, getAgentPersonaTemplate } from '@dex-agents/shared';
import { validateBody, ValidationError } from '../lib/validation.js';
import { generateId, nowIso, autonomyLevelToInt, intToAutonomyLevel } from '../lib/utils.js';
import { normalizePairsForDex } from '../lib/pairs.js';

const agentsRoute = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

function formatAgent(r: typeof agents.$inferSelect) {
  return {
    ...r,
    autonomyLevel: intToAutonomyLevel(r.autonomyLevel),
    config: JSON.parse(r.config),
  };
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

  const id = generateId('agent');
  const now = nowIso();
  const autonomyLevel = autonomyLevelToInt(body.autonomyLevel);
  const config = {
    ...body,
    pairs: normalizePairsForDex(body.pairs),
  };

  await db.insert(agents).values({
    id,
    name: body.name,
    status: 'stopped',
    autonomyLevel,
    config: JSON.stringify(config),
    llmModel: body.llmModel,
    ownerAddress: walletAddress,
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
  const mergedConfig = {
    ...existingConfig,
    ...body,
    ...(body.pairs !== undefined && { pairs: normalizePairsForDex(body.pairs) }),
  };

  const updates: Partial<typeof agents.$inferInsert> = {
    config: JSON.stringify(mergedConfig),
    updatedAt: nowIso(),
  };
  if (body.name) updates.name = body.name;
  // Always sync llm_model column from merged config so the agent loop uses the selected model
  updates.llmModel = (mergedConfig.llmModel ?? existing.llmModel) || 'nvidia/nemotron-3-nano-30b-a3b:free';
  if (body.autonomyLevel) updates.autonomyLevel = autonomyLevelToInt(body.autonomyLevel);
  if (body.profileId !== undefined) updates.profileId = body.profileId ?? null;
  if (body.personaMd !== undefined) updates.personaMd = body.personaMd ?? null;

  await db.update(agents).set(updates).where(eq(agents.id, id));

  const [updated] = await db.select().from(agents).where(eq(agents.id, id));
  return c.json({
    ...formatAgent(updated),
    pendingRestart: existing.status === 'running',
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
      const doId = c.env.TRADING_AGENT.idFromName(id);
      const stub = c.env.TRADING_AGENT.get(doId);
      await stub.fetch(new Request('http://do/stop', { method: 'POST' }));
    } catch (err) {
      console.error('[agents route] Failed to stop TRADING_AGENT DO before delete', err);
    }
    await db.update(agents).set({ status: 'stopped', updatedAt: nowIso() }).where(eq(agents.id, id));
  }

  await db.delete(trades).where(eq(trades.agentId, id));
  await db.delete(agentDecisions).where(eq(agentDecisions.agentId, id));
  await db.delete(performanceSnapshots).where(eq(performanceSnapshots.agentId, id));
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
  const doId = c.env.TRADING_AGENT.idFromName(id);
  const stub = c.env.TRADING_AGENT.get(doId);
  await stub.fetch(
    new Request('http://do/start', {
      method: 'POST',
      body: JSON.stringify({
        agentId: id,
        paperBalance: agentConfig.paperBalance,
        slippageSimulation: agentConfig.slippageSimulation,
        analysisInterval: agentConfig.analysisInterval,
      }),
    })
  );

  await db.update(agents).set({ status: 'running', updatedAt: nowIso() }).where(eq(agents.id, id));
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

  const doId = c.env.TRADING_AGENT.idFromName(id);
  const stub = c.env.TRADING_AGENT.get(doId);
  await stub.fetch(new Request('http://do/stop', { method: 'POST' }));
  await db.update(agents).set({ status: 'stopped', updatedAt: nowIso() }).where(eq(agents.id, id));
  return c.json({ ok: true, status: 'stopped' });
});

/** POST /api/agents/:id/pause */
agentsRoute.post('/:id/pause', async (c) => {
  const id = c.req.param('id');
  const walletAddress = c.get('walletAddress');
  const db = drizzle(c.env.DB);

  const agent = await requireOwnership(db, id, walletAddress);
  if (!agent) return c.json({ error: 'Agent not found' }, 404);

  const doId = c.env.TRADING_AGENT.idFromName(id);
  const stub = c.env.TRADING_AGENT.get(doId);
  await stub.fetch(new Request('http://do/pause', { method: 'POST' }));
  await db.update(agents).set({ status: 'paused', updatedAt: nowIso() }).where(eq(agents.id, id));
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
    return c.json({ error: body.error ?? 'Analysis failed' }, 500);
  }
  return c.json({ ok: true });
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
  const profileId = config.profileId ?? agent.profileId ?? 'the_bot';
  const personaMd = getAgentPersonaTemplate(profileId, agent.name);
  await db.update(agents).set({ personaMd, updatedAt: nowIso() }).where(eq(agents.id, id));
  return c.json({ ok: true, personaMd });
});

/** GET /api/agents/:id/prompt-preview */
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
    ? (JSON.parse(lastDecision.marketDataSnapshot) as Array<{
        pair: string; priceUsd: number; priceChange: Record<string, number | undefined>;
        volume24h?: number; liquidity?: number; indicatorText: string;
      }>)
    : [];

  const recentDecisions = await db
    .select({ decision: agentDecisions.decision, confidence: agentDecisions.confidence, createdAt: agentDecisions.createdAt })
    .from(agentDecisions)
    .where(eq(agentDecisions.agentId, id))
    .orderBy(desc(agentDecisions.createdAt))
    .limit(10);

  const openTrades = await db.select().from(trades).where(eq(trades.agentId, id));
  const openPositions = openTrades
    .filter((t) => t.status === 'open')
    .map((t) => ({
      pair: t.pair,
      side: t.side as 'buy' | 'sell',
      entryPrice: t.entryPrice,
      amountUsd: t.amountUsd,
      unrealizedPct: 0,
      currentPrice: t.entryPrice,
      openedAt: t.openedAt,
      slPct: (config.stopLossPct as number) ?? 5,
      tpPct: (config.takeProfitPct as number) ?? 7,
    }));

  const autonomyLevel = intToAutonomyLevel(agent.autonomyLevel) as 'full' | 'guided' | 'strict';
  const systemPrompt = BASE_AGENT_PROMPT + JSON_SCHEMA_INSTRUCTION;
  const userPrompt = rawMarketData.length > 0
    ? buildAnalysisPrompt({
        portfolioState: {
          balance: (config.paperBalance as number) ?? 10000,
          openPositions: openPositions.length,
          dailyPnlPct: 0,
          totalPnlPct: 0,
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
        autonomyLevel,
        behavior: config.behavior as any,
        personaMd: agent.personaMd,
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
  const mods = await db
    .select()
    .from(agentSelfModifications)
    .where(eq(agentSelfModifications.agentId, id))
    .orderBy(desc(agentSelfModifications.createdAt))
    .limit(20);
  return c.json({ modifications: mods });
});

/** POST /api/agents/:id/self-modifications/:modId/approve */
agentsRoute.post('/:id/self-modifications/:modId/approve', async (c) => {
  const id = c.req.param('id');
  const modId = c.req.param('modId');
  const walletAddress = c.get('walletAddress');
  const db = drizzle(c.env.DB);
  const agent = await requireOwnership(db, id, walletAddress);
  if (!agent) return c.json({ error: 'Agent not found' }, 404);

  const [mod] = await db.select().from(agentSelfModifications).where(eq(agentSelfModifications.id, modId));
  if (!mod || mod.agentId !== id || mod.status !== 'pending') {
    return c.json({ error: 'Modification not found or not pending' }, 404);
  }

  const changes = JSON.parse(mod.changesApplied ?? mod.changes) as {
    personaMd?: string;
    behavior?: Record<string, unknown>;
    config?: { stopLossPct?: number; takeProfitPct?: number; maxPositionSizePct?: number };
  };

  const existingConfig = JSON.parse(agent.config) as Record<string, unknown>;
  const agentUpdates: Partial<typeof agents.$inferInsert> = { updatedAt: nowIso() };
  const configPatch: Record<string, unknown> = {};

  if (changes.personaMd) agentUpdates.personaMd = changes.personaMd;
  if (changes.behavior) configPatch.behavior = { ...(existingConfig.behavior as object ?? {}), ...changes.behavior };
  if (changes.config) {
    if (changes.config.stopLossPct !== undefined)        configPatch.stopLossPct        = changes.config.stopLossPct;
    if (changes.config.takeProfitPct !== undefined)      configPatch.takeProfitPct      = changes.config.takeProfitPct;
    if (changes.config.maxPositionSizePct !== undefined) configPatch.maxPositionSizePct = changes.config.maxPositionSizePct;
  }
  if (Object.keys(configPatch).length > 0) {
    agentUpdates.config = JSON.stringify({ ...existingConfig, ...configPatch });
  }

  await db.update(agents).set(agentUpdates).where(eq(agents.id, id));
  await db.update(agentSelfModifications)
    .set({ status: 'applied', appliedAt: nowIso() })
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

  await db.update(agentSelfModifications)
    .set({ status: 'rejected' })
    .where(eq(agentSelfModifications.id, modId));
  return c.json({ ok: true });
});

// Error handler
agentsRoute.onError((err, c) => {
  if (err instanceof ValidationError) {
    return c.json({ error: err.message, fieldErrors: err.fieldErrors }, 400);
  }
  console.error('[agents route]', err);
  return c.json({ error: 'Internal server error' }, 500);
});

export default agentsRoute;
