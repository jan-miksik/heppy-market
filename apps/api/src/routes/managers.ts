import { Hono } from 'hono';
import { drizzle } from 'drizzle-orm/d1';
import { eq, desc, inArray } from 'drizzle-orm';
import type { Env } from '../types/env.js';
import type { AuthVariables } from '../lib/auth.js';
import { agentManagers, agentManagerLogs, agents, trades, agentDecisions, performanceSnapshots } from '../db/schema.js';
import { CreateManagerRequestSchema, UpdateManagerRequestSchema, UpdatePersonaSchema, getManagerPersonaTemplate } from '@dex-agents/shared';
import { validateBody } from '../lib/validation.js';
import { generateId, nowIso } from '../lib/utils.js';

const managersRoute = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

function formatManager(r: typeof agentManagers.$inferSelect) {
  return {
    ...r,
    config: JSON.parse(r.config),
  };
}

async function requireManagerOwnership(
  db: ReturnType<typeof drizzle>,
  id: string,
  walletAddress: string
): Promise<typeof agentManagers.$inferSelect | null> {
  const [manager] = await db.select().from(agentManagers).where(eq(agentManagers.id, id));
  if (!manager) return null;
  if (manager.ownerAddress !== walletAddress) return null;
  return manager;
}

/** GET /api/managers */
managersRoute.get('/', async (c) => {
  const walletAddress = c.get('walletAddress');
  const db = drizzle(c.env.DB);
  const rows = await db
    .select()
    .from(agentManagers)
    .where(eq(agentManagers.ownerAddress, walletAddress))
    .orderBy(desc(agentManagers.createdAt));
  return c.json({ managers: rows.map(formatManager) });
});

/** POST /api/managers */
managersRoute.post('/', async (c) => {
  const body = await validateBody(c, CreateManagerRequestSchema);
  const walletAddress = c.get('walletAddress');
  const db = drizzle(c.env.DB);

  const id = generateId('mgr');
  const now = nowIso();
  const config = {
    llmModel: body.llmModel,
    temperature: body.temperature,
    decisionInterval: body.decisionInterval,
    riskParams: body.riskParams ?? { maxTotalDrawdown: 0.2, maxAgents: 10, maxCorrelatedPositions: 3 },
  };

  await db.insert(agentManagers).values({
    id,
    name: body.name,
    ownerAddress: walletAddress,
    config: JSON.stringify(config),
    status: 'stopped',
    createdAt: now,
    updatedAt: now,
  });

  // Automatically start the manager after creation so it is active by default
  const decisionInterval = config.decisionInterval ?? '1h';
  try {
    const doId = c.env.AGENT_MANAGER.idFromName(id);
    const stub = c.env.AGENT_MANAGER.get(doId);
    await stub.fetch(new Request('http://do/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ managerId: id, decisionInterval }),
    }));
    await db.update(agentManagers).set({ status: 'running', updatedAt: nowIso() }).where(eq(agentManagers.id, id));
  } catch (err) {
    console.error('[managers] Failed to auto-start manager on create', err);
  }

  const [created] = await db.select().from(agentManagers).where(eq(agentManagers.id, id));
  return c.json(formatManager(created), 201);
});

/** GET /api/managers/:id */
managersRoute.get('/:id', async (c) => {
  const id = c.req.param('id');
  const walletAddress = c.get('walletAddress');
  const db = drizzle(c.env.DB);
  const manager = await requireManagerOwnership(db, id, walletAddress);
  if (!manager) return c.json({ error: 'Manager not found' }, 404);

  // Include DO status
  let doStatus: Record<string, unknown> = {};
  try {
    const doId = c.env.AGENT_MANAGER.idFromName(id);
    const stub = c.env.AGENT_MANAGER.get(doId);
    const res = await stub.fetch(new Request('http://do/status'));
    doStatus = await res.json() as Record<string, unknown>;
  } catch { /* ignore */ }

  return c.json({ ...formatManager(manager), doStatus });
});

/** PATCH /api/managers/:id */
managersRoute.patch('/:id', async (c) => {
  const id = c.req.param('id');
  const walletAddress = c.get('walletAddress');
  const body = await validateBody(c, UpdateManagerRequestSchema);
  const db = drizzle(c.env.DB);

  const existing = await requireManagerOwnership(db, id, walletAddress);
  if (!existing) return c.json({ error: 'Manager not found' }, 404);

  const existingConfig = JSON.parse(existing.config);
  const mergedConfig = { ...existingConfig, ...body };

  await db.update(agentManagers).set({
    name: body.name ?? existing.name,
    config: JSON.stringify(mergedConfig),
    updatedAt: nowIso(),
  }).where(eq(agentManagers.id, id));

  const [updated] = await db.select().from(agentManagers).where(eq(agentManagers.id, id));
  return c.json(formatManager(updated));
});

/** DELETE /api/managers/:id?deleteAgents=true */
managersRoute.delete('/:id', async (c) => {
  const id = c.req.param('id');
  const walletAddress = c.get('walletAddress');
  const deleteAgents = c.req.query('deleteAgents') === 'true';
  const db = drizzle(c.env.DB);

  const existing = await requireManagerOwnership(db, id, walletAddress);
  if (!existing) return c.json({ error: 'Manager not found' }, 404);

  // Stop the DO alarm if running
  if (existing.status === 'running' || existing.status === 'paused') {
    const doId = c.env.AGENT_MANAGER.idFromName(id);
    const stub = c.env.AGENT_MANAGER.get(doId);
    await stub.fetch(new Request('http://do/stop', { method: 'POST' }));
  }

  if (deleteAgents) {
    // Stop each managed agent's DO, then delete agents + all related rows
    const managedAgents = await db.select({ id: agents.id, status: agents.status }).from(agents).where(eq(agents.managerId, id));
    if (managedAgents.length > 0) {
      const agentIds = managedAgents.map((a) => a.id);
      for (const agent of managedAgents) {
        if (agent.status === 'running' || agent.status === 'paused') {
          try {
            const doId = c.env.TRADING_AGENT.idFromName(agent.id);
            const stub = c.env.TRADING_AGENT.get(doId);
            await stub.fetch(new Request('http://do/stop', { method: 'POST' }));
          } catch { /* best-effort */ }
        }
      }
      // Delete child rows before agents (trades has a FK on agentId)
      await db.delete(trades).where(inArray(trades.agentId, agentIds));
      await db.delete(agentDecisions).where(inArray(agentDecisions.agentId, agentIds));
      await db.delete(performanceSnapshots).where(inArray(performanceSnapshots.agentId, agentIds));
      await db.delete(agents).where(inArray(agents.id, agentIds));
    }
  } else {
    // Just detach agents from this manager
    await db.update(agents).set({ managerId: null }).where(eq(agents.managerId, id));
  }

  await db.delete(agentManagerLogs).where(eq(agentManagerLogs.managerId, id));
  await db.delete(agentManagers).where(eq(agentManagers.id, id));
  return c.json({ ok: true });
});

/** POST /api/managers/:id/start */
managersRoute.post('/:id/start', async (c) => {
  const id = c.req.param('id');
  const walletAddress = c.get('walletAddress');
  const db = drizzle(c.env.DB);

  const manager = await requireManagerOwnership(db, id, walletAddress);
  if (!manager) return c.json({ error: 'Manager not found' }, 404);

  const config = JSON.parse(manager.config) as { decisionInterval?: string };
  const doId = c.env.AGENT_MANAGER.idFromName(id);
  const stub = c.env.AGENT_MANAGER.get(doId);

  await stub.fetch(new Request('http://do/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ managerId: id, decisionInterval: config.decisionInterval ?? '1h' }),
  }));

  await db.update(agentManagers).set({ status: 'running', updatedAt: nowIso() }).where(eq(agentManagers.id, id));
  return c.json({ ok: true, status: 'running' });
});

/** POST /api/managers/:id/stop */
managersRoute.post('/:id/stop', async (c) => {
  const id = c.req.param('id');
  const walletAddress = c.get('walletAddress');
  const db = drizzle(c.env.DB);

  const manager = await requireManagerOwnership(db, id, walletAddress);
  if (!manager) return c.json({ error: 'Manager not found' }, 404);

  const doId = c.env.AGENT_MANAGER.idFromName(id);
  const stub = c.env.AGENT_MANAGER.get(doId);
  await stub.fetch(new Request('http://do/stop', { method: 'POST' }));

  await db.update(agentManagers).set({ status: 'stopped', updatedAt: nowIso() }).where(eq(agentManagers.id, id));
  return c.json({ ok: true, status: 'stopped' });
});

/** POST /api/managers/:id/pause */
managersRoute.post('/:id/pause', async (c) => {
  const id = c.req.param('id');
  const walletAddress = c.get('walletAddress');
  const db = drizzle(c.env.DB);

  const manager = await requireManagerOwnership(db, id, walletAddress);
  if (!manager) return c.json({ error: 'Manager not found' }, 404);

  const doId = c.env.AGENT_MANAGER.idFromName(id);
  const stub = c.env.AGENT_MANAGER.get(doId);
  await stub.fetch(new Request('http://do/pause', { method: 'POST' }));

  await db.update(agentManagers).set({ status: 'paused', updatedAt: nowIso() }).where(eq(agentManagers.id, id));
  return c.json({ ok: true, status: 'paused' });
});

/** POST /api/managers/:id/trigger */
managersRoute.post('/:id/trigger', async (c) => {
  const id = c.req.param('id');
  const walletAddress = c.get('walletAddress');
  const db = drizzle(c.env.DB);

  const manager = await requireManagerOwnership(db, id, walletAddress);
  if (!manager) return c.json({ error: 'Manager not found' }, 404);

  const doId = c.env.AGENT_MANAGER.idFromName(id);
  const stub = c.env.AGENT_MANAGER.get(doId);
  const res = await stub.fetch(new Request('http://do/trigger', { method: 'POST' }));
  const body = await res.json() as { ok?: boolean; error?: string };

  if (!res.ok) return c.json({ error: body.error ?? 'Failed to trigger' }, res.status as 400 | 409);
  return c.json({ ok: true });
});

/** GET /api/managers/:id/logs */
managersRoute.get('/:id/logs', async (c) => {
  const id = c.req.param('id');
  const walletAddress = c.get('walletAddress');
  const db = drizzle(c.env.DB);

  const manager = await requireManagerOwnership(db, id, walletAddress);
  if (!manager) return c.json({ error: 'Manager not found' }, 404);

  const page = Math.max(1, parseInt(c.req.query('page') ?? '1', 10));
  const limit = Math.min(50, Math.max(1, parseInt(c.req.query('limit') ?? '20', 10)));
  const offset = (page - 1) * limit;

  const logs = await db
    .select()
    .from(agentManagerLogs)
    .where(eq(agentManagerLogs.managerId, id))
    .orderBy(desc(agentManagerLogs.createdAt))
    .limit(limit)
    .offset(offset);

  return c.json({
    logs: logs.map((l) => ({ ...l, result: JSON.parse(l.result) })),
    page,
    limit,
  });
});

/** GET /api/managers/:id/agents */
managersRoute.get('/:id/agents', async (c) => {
  const id = c.req.param('id');
  const walletAddress = c.get('walletAddress');
  const db = drizzle(c.env.DB);

  const manager = await requireManagerOwnership(db, id, walletAddress);
  if (!manager) return c.json({ error: 'Manager not found' }, 404);

  const managedAgents = await db.select().from(agents).where(eq(agents.managerId, id));
  return c.json({
    agents: managedAgents.map((r) => ({
      ...r,
      config: JSON.parse(r.config),
    })),
  });
});

/** GET /api/managers/:id/persona */
managersRoute.get('/:id/persona', async (c) => {
  const id = c.req.param('id');
  const walletAddress = c.get('walletAddress');
  const db = drizzle(c.env.DB);
  const manager = await requireManagerOwnership(db, id, walletAddress);
  if (!manager) return c.json({ error: 'Manager not found' }, 404);
  return c.json({ personaMd: manager.personaMd ?? null, profileId: manager.profileId ?? null });
});

/** PUT /api/managers/:id/persona */
managersRoute.put('/:id/persona', async (c) => {
  const id = c.req.param('id');
  const walletAddress = c.get('walletAddress');
  const body = await validateBody(c, UpdatePersonaSchema);
  const db = drizzle(c.env.DB);
  const manager = await requireManagerOwnership(db, id, walletAddress);
  if (!manager) return c.json({ error: 'Manager not found' }, 404);
  await db.update(agentManagers).set({ personaMd: body.personaMd, updatedAt: nowIso() }).where(eq(agentManagers.id, id));
  return c.json({ ok: true, personaMd: body.personaMd });
});

/** POST /api/managers/:id/persona/reset */
managersRoute.post('/:id/persona/reset', async (c) => {
  const id = c.req.param('id');
  const walletAddress = c.get('walletAddress');
  const db = drizzle(c.env.DB);
  const manager = await requireManagerOwnership(db, id, walletAddress);
  if (!manager) return c.json({ error: 'Manager not found' }, 404);
  const config = JSON.parse(manager.config) as { profileId?: string };
  const profileId = config.profileId ?? manager.profileId ?? 'passive_index';
  const personaMd = getManagerPersonaTemplate(profileId, manager.name);
  await db.update(agentManagers).set({ personaMd, updatedAt: nowIso() }).where(eq(agentManagers.id, id));
  return c.json({ ok: true, personaMd });
});

export default managersRoute;
