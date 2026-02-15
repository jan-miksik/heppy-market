import { Hono } from 'hono';
import { z } from 'zod';
import { drizzle } from 'drizzle-orm/d1';
import { eq, desc } from 'drizzle-orm';
import type { Env } from '../types/env.js';
import { agents, trades, agentDecisions, performanceSnapshots } from '../db/schema.js';
import { CreateAgentRequestSchema, UpdateAgentRequestSchema } from '@dex-agents/shared';
import { validateBody, ValidationError } from '../lib/validation.js';
import { generateId, nowIso, autonomyLevelToInt, intToAutonomyLevel } from '../lib/utils.js';

const agentsRoute = new Hono<{ Bindings: Env }>();

/** GET /api/agents — list all agents */
agentsRoute.get('/', async (c) => {
  const db = drizzle(c.env.DB);
  const rows = await db.select().from(agents).orderBy(desc(agents.createdAt));
  return c.json({
    agents: rows.map((r) => ({
      ...r,
      autonomyLevel: intToAutonomyLevel(r.autonomyLevel),
      config: JSON.parse(r.config),
    })),
  });
});

/** POST /api/agents — create agent */
agentsRoute.post('/', async (c) => {
  const body = await validateBody(c, CreateAgentRequestSchema);
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
    createdAt: now,
    updatedAt: now,
  });

  const [created] = await db.select().from(agents).where(eq(agents.id, id));
  return c.json(
    {
      ...created,
      autonomyLevel: intToAutonomyLevel(created.autonomyLevel),
      config: JSON.parse(created.config),
    },
    201
  );
});

/** GET /api/agents/:id — get single agent */
agentsRoute.get('/:id', async (c) => {
  const id = c.req.param('id');
  const db = drizzle(c.env.DB);

  const [agent] = await db.select().from(agents).where(eq(agents.id, id));
  if (!agent) return c.json({ error: 'Agent not found' }, 404);

  return c.json({
    ...agent,
    autonomyLevel: intToAutonomyLevel(agent.autonomyLevel),
    config: JSON.parse(agent.config),
  });
});

/** PATCH /api/agents/:id — update agent config */
agentsRoute.patch('/:id', async (c) => {
  const id = c.req.param('id');
  const body = await validateBody(c, UpdateAgentRequestSchema);
  const db = drizzle(c.env.DB);

  const [existing] = await db.select().from(agents).where(eq(agents.id, id));
  if (!existing) return c.json({ error: 'Agent not found' }, 404);

  if (existing.status === 'running') {
    return c.json({ error: 'Stop the agent before updating config' }, 409);
  }

  const existingConfig = JSON.parse(existing.config);
  const mergedConfig = { ...existingConfig, ...body };

  const updates: Partial<typeof agents.$inferInsert> = {
    config: JSON.stringify(mergedConfig),
    updatedAt: nowIso(),
  };
  if (body.name) updates.name = body.name;
  if (body.llmModel) updates.llmModel = body.llmModel;
  if (body.autonomyLevel) updates.autonomyLevel = autonomyLevelToInt(body.autonomyLevel);

  await db.update(agents).set(updates).where(eq(agents.id, id));

  const [updated] = await db.select().from(agents).where(eq(agents.id, id));
  return c.json({
    ...updated,
    autonomyLevel: intToAutonomyLevel(updated.autonomyLevel),
    config: JSON.parse(updated.config),
  });
});

/** DELETE /api/agents/:id — delete agent */
agentsRoute.delete('/:id', async (c) => {
  const id = c.req.param('id');
  const db = drizzle(c.env.DB);

  const [existing] = await db.select().from(agents).where(eq(agents.id, id));
  if (!existing) return c.json({ error: 'Agent not found' }, 404);

  if (existing.status === 'running') {
    return c.json({ error: 'Stop the agent before deleting' }, 409);
  }

  await db.delete(agents).where(eq(agents.id, id));
  return c.json({ ok: true });
});

/** POST /api/agents/:id/start — start agent */
agentsRoute.post('/:id/start', async (c) => {
  const id = c.req.param('id');
  const db = drizzle(c.env.DB);

  const [agent] = await db.select().from(agents).where(eq(agents.id, id));
  if (!agent) return c.json({ error: 'Agent not found' }, 404);

  if (agent.status === 'running') {
    return c.json({ ok: true, status: 'running', message: 'Already running' });
  }

  // Get or create DO instance for this agent
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

  await db
    .update(agents)
    .set({ status: 'running', updatedAt: nowIso() })
    .where(eq(agents.id, id));

  return c.json({ ok: true, status: 'running' });
});

/** POST /api/agents/:id/stop — stop agent */
agentsRoute.post('/:id/stop', async (c) => {
  const id = c.req.param('id');
  const db = drizzle(c.env.DB);

  const [agent] = await db.select().from(agents).where(eq(agents.id, id));
  if (!agent) return c.json({ error: 'Agent not found' }, 404);

  const doId = c.env.TRADING_AGENT.idFromName(id);
  const stub = c.env.TRADING_AGENT.get(doId);
  await stub.fetch(
    new Request('http://do/stop', { method: 'POST' })
  );

  await db
    .update(agents)
    .set({ status: 'stopped', updatedAt: nowIso() })
    .where(eq(agents.id, id));

  return c.json({ ok: true, status: 'stopped' });
});

/** POST /api/agents/:id/pause — pause agent */
agentsRoute.post('/:id/pause', async (c) => {
  const id = c.req.param('id');
  const db = drizzle(c.env.DB);

  const [agent] = await db.select().from(agents).where(eq(agents.id, id));
  if (!agent) return c.json({ error: 'Agent not found' }, 404);

  const doId = c.env.TRADING_AGENT.idFromName(id);
  const stub = c.env.TRADING_AGENT.get(doId);
  await stub.fetch(
    new Request('http://do/pause', { method: 'POST' })
  );

  await db
    .update(agents)
    .set({ status: 'paused', updatedAt: nowIso() })
    .where(eq(agents.id, id));

  return c.json({ ok: true, status: 'paused' });
});

/** GET /api/agents/:id/trades — agent's trade history */
agentsRoute.get('/:id/trades', async (c) => {
  const id = c.req.param('id');
  const db = drizzle(c.env.DB);

  const [agent] = await db.select().from(agents).where(eq(agents.id, id));
  if (!agent) return c.json({ error: 'Agent not found' }, 404);

  const agentTrades = await db
    .select()
    .from(trades)
    .where(eq(trades.agentId, id))
    .orderBy(desc(trades.openedAt));

  return c.json({ trades: agentTrades });
});

/** GET /api/agents/:id/decisions — agent's decision log */
agentsRoute.get('/:id/decisions', async (c) => {
  const id = c.req.param('id');
  const db = drizzle(c.env.DB);

  const [agent] = await db.select().from(agents).where(eq(agents.id, id));
  if (!agent) return c.json({ error: 'Agent not found' }, 404);

  const decisions = await db
    .select()
    .from(agentDecisions)
    .where(eq(agentDecisions.agentId, id))
    .orderBy(desc(agentDecisions.createdAt));

  return c.json({ decisions });
});

/** GET /api/agents/:id/performance — performance snapshots */
agentsRoute.get('/:id/performance', async (c) => {
  const id = c.req.param('id');
  const db = drizzle(c.env.DB);

  const [agent] = await db.select().from(agents).where(eq(agents.id, id));
  if (!agent) return c.json({ error: 'Agent not found' }, 404);

  const snapshots = await db
    .select()
    .from(performanceSnapshots)
    .where(eq(performanceSnapshots.agentId, id))
    .orderBy(desc(performanceSnapshots.snapshotAt));

  return c.json({ snapshots });
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
