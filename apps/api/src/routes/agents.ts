import { Hono } from 'hono';
import { drizzle } from 'drizzle-orm/d1';
import { eq, desc, or, isNull } from 'drizzle-orm';
import type { Env } from '../types/env.js';
import type { AuthVariables } from '../lib/auth.js';
import { agents, trades, agentDecisions, performanceSnapshots } from '../db/schema.js';
import { CreateAgentRequestSchema, UpdateAgentRequestSchema, UpdatePersonaSchema, getAgentPersonaTemplate } from '@dex-agents/shared';
import { validateBody, ValidationError } from '../lib/validation.js';
import { generateId, nowIso, autonomyLevelToInt, intToAutonomyLevel } from '../lib/utils.js';

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
  const config = { ...body };

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

  const existingConfig = JSON.parse(existing.config);
  const mergedConfig = { ...existingConfig, ...body };

  const updates: Partial<typeof agents.$inferInsert> = {
    config: JSON.stringify(mergedConfig),
    updatedAt: nowIso(),
  };
  if (body.name) updates.name = body.name;
  // Always sync llm_model column from merged config so the agent loop uses the selected model
  updates.llmModel = (mergedConfig.llmModel ?? existing.llmModel) || 'nvidia/nemotron-3-nano-30b-a3b:free';
  if (body.autonomyLevel) updates.autonomyLevel = autonomyLevelToInt(body.autonomyLevel);

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
    const doId = c.env.TRADING_AGENT.idFromName(id);
    const stub = c.env.TRADING_AGENT.get(doId);
    await stub.fetch(new Request('http://do/stop', { method: 'POST' }));
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

// Error handler
agentsRoute.onError((err, c) => {
  if (err instanceof ValidationError) {
    return c.json({ error: err.message, fieldErrors: err.fieldErrors }, 400);
  }
  console.error('[agents route]', err);
  return c.json({ error: 'Internal server error' }, 500);
});

export default agentsRoute;
