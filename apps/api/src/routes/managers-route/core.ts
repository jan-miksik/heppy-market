import { desc, eq, inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { CreateManagerRequestSchema, UpdateManagerRequestSchema } from '@something-in-loop/shared';
import { agentDecisions, agentManagerLogs, agentManagers, agents, performanceSnapshots, trades } from '../../db/schema.js';
import { nowIso, generateId } from '../../lib/utils.js';
import { validateBody } from '../../lib/validation.js';
import { normalizeManagerDecisionInterval, syncRunningManagerDecisionInterval } from '../../lib/manager-interval-sync.js';
import { startManagerDo, stopManagerDo, stopTradingAgentDo } from '../../lib/do-clients.js';
import { formatManager, parseManagerConfig, withOwnedManager } from './shared.js';
import type { ManagersRoute } from './shared.js';

export function registerManagerCoreRoutes(managersRoute: ManagersRoute): void {
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
      ...(body.behavior ? { behavior: body.behavior } : {}),
      ...(body.profileId ? { profileId: body.profileId } : {}),
    };

    await db.insert(agentManagers).values({
      id,
      name: body.name,
      ownerAddress: walletAddress,
      config: JSON.stringify(config),
      personaMd: (body as { personaMd?: string | null }).personaMd ?? null,
      profileId: body.profileId ?? null,
      status: 'stopped',
      createdAt: now,
      updatedAt: now,
    });

    // Automatically start the manager after creation so it is active by default
    const decisionInterval = normalizeManagerDecisionInterval(config.decisionInterval);
    try {
      await startManagerDo(c.env, { managerId: id, decisionInterval });
      await db.update(agentManagers).set({ status: 'running', updatedAt: nowIso() }).where(eq(agentManagers.id, id));
    } catch (err) {
      console.error('[managers] Failed to auto-start manager on create', err);
    }

    const [created] = await db.select().from(agentManagers).where(eq(agentManagers.id, id));
    return c.json(formatManager(created), 201);
  });

  /** GET /api/managers/:id */
  managersRoute.get('/:id', async (c) => {
    return withOwnedManager(c, async ({ id, manager }) => {
      // Include DO status
      let doStatus: Record<string, unknown> = {};
      try {
        const doId = c.env.AGENT_MANAGER.idFromName(id);
        const stub = c.env.AGENT_MANAGER.get(doId);
        const res = await stub.fetch(new Request('http://do/status'));
        doStatus = await res.json() as Record<string, unknown>;
      } catch {
        // ignore
      }

      return c.json({ ...formatManager(manager), doStatus });
    });
  });

  /** PATCH /api/managers/:id */
  managersRoute.patch('/:id', async (c) => {
    const body = await validateBody(c, UpdateManagerRequestSchema);

    return withOwnedManager(c, async ({ id, db, manager: existing }) => {
      const { personaMd, ...configPatch } = body as any;
      const existingConfig = parseManagerConfig(existing.config);
      const mergedConfig = { ...existingConfig, ...configPatch };
      const previousDecisionInterval = typeof existingConfig.decisionInterval === 'string' ? existingConfig.decisionInterval : undefined;
      const nextDecisionInterval = typeof mergedConfig.decisionInterval === 'string' ? mergedConfig.decisionInterval : undefined;

      const updates: Partial<typeof agentManagers.$inferInsert> = {
        name: body.name ?? existing.name,
        config: JSON.stringify(mergedConfig),
        updatedAt: nowIso(),
      };
      if (personaMd !== undefined) updates.personaMd = personaMd;
      if (body.profileId !== undefined) updates.profileId = body.profileId ?? null;

      await db.update(agentManagers).set(updates).where(eq(agentManagers.id, id));
      try {
        await syncRunningManagerDecisionInterval(
          c.env,
          id,
          existing.status,
          previousDecisionInterval,
          nextDecisionInterval,
        );
      } catch (err) {
        console.warn(`[managers route] Failed to sync decisionInterval to AGENT_MANAGER DO for ${id}:`, err);
      }

      const [updated] = await db.select().from(agentManagers).where(eq(agentManagers.id, id));
      return c.json(formatManager(updated));
    });
  });

  /** DELETE /api/managers/:id?deleteAgents=true */
  managersRoute.delete('/:id', async (c) => {
    const deleteAgents = c.req.query('deleteAgents') === 'true';

    return withOwnedManager(c, async ({ id, db, manager: existing }) => {
      // Stop the DO alarm if running
      if (existing.status === 'running' || existing.status === 'paused') {
        await stopManagerDo(c.env, id);
      }

      if (deleteAgents) {
        // Stop each managed agent's DO, then delete agents + all related rows
        const managedAgents = await db.select({ id: agents.id, status: agents.status }).from(agents).where(eq(agents.managerId, id));
        if (managedAgents.length > 0) {
          const agentIds = managedAgents.map((a) => a.id);
          for (const agent of managedAgents) {
            if (agent.status === 'running' || agent.status === 'paused') {
              try {
                await stopTradingAgentDo(c.env, agent.id);
              } catch {
                // best-effort
              }
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
  });
}
