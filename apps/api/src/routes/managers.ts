import { Hono } from 'hono';
import { drizzle } from 'drizzle-orm/d1';
import { eq, desc } from 'drizzle-orm';
import type { Env } from '../types/env.js';
import type { AuthVariables } from '../lib/auth.js';
import { agentManagers, agentManagerLogs, agents } from '../db/schema.js';
import { CreateManagerRequestSchema, UpdateManagerRequestSchema } from '@dex-agents/shared';
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

/** DELETE /api/managers/:id */
managersRoute.delete('/:id', async (c) => {
  const id = c.req.param('id');
  const walletAddress = c.get('walletAddress');
  const db = drizzle(c.env.DB);

  const existing = await requireManagerOwnership(db, id, walletAddress);
  if (!existing) return c.json({ error: 'Manager not found' }, 404);

  if (existing.status === 'running' || existing.status === 'paused') {
    const doId = c.env.AGENT_MANAGER.idFromName(id);
    const stub = c.env.AGENT_MANAGER.get(doId);
    await stub.fetch(new Request('http://do/stop', { method: 'POST' }));
  }

  await db.update(agents).set({ managerId: null }).where(eq(agents.managerId, id));
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

export default managersRoute;
