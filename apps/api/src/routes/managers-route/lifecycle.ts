import { eq } from 'drizzle-orm';
import { agentManagers } from '../../db/schema.js';
import { nowIso } from '../../lib/utils.js';
import { DoRequestError, pauseManagerDo, startManagerDo, stopManagerDo, triggerManagerDo } from '../../lib/do-clients.js';
import { normalizeManagerDecisionInterval } from '../../lib/manager-interval-sync.js';
import { parseManagerConfig, withOwnedManager } from './shared.js';
import type { ManagersRoute } from './shared.js';

export function registerManagerLifecycleRoutes(managersRoute: ManagersRoute): void {
  /** POST /api/managers/:id/start */
  managersRoute.post('/:id/start', async (c) => {
    return withOwnedManager(c, async ({ id, db, manager }) => {
      const config = parseManagerConfig(manager.config) as { decisionInterval?: string };
      const decisionInterval = normalizeManagerDecisionInterval(config.decisionInterval);
      await startManagerDo(c.env, { managerId: id, decisionInterval });

      await db.update(agentManagers).set({ status: 'running', updatedAt: nowIso() }).where(eq(agentManagers.id, id));
      return c.json({ ok: true, status: 'running' });
    });
  });

  /** POST /api/managers/:id/stop */
  managersRoute.post('/:id/stop', async (c) => {
    return withOwnedManager(c, async ({ id, db }) => {
      await stopManagerDo(c.env, id);

      await db.update(agentManagers).set({ status: 'stopped', updatedAt: nowIso() }).where(eq(agentManagers.id, id));
      return c.json({ ok: true, status: 'stopped' });
    });
  });

  /** POST /api/managers/:id/pause */
  managersRoute.post('/:id/pause', async (c) => {
    return withOwnedManager(c, async ({ id, db }) => {
      await pauseManagerDo(c.env, id);

      await db.update(agentManagers).set({ status: 'paused', updatedAt: nowIso() }).where(eq(agentManagers.id, id));
      return c.json({ ok: true, status: 'paused' });
    });
  });

  /** POST /api/managers/:id/trigger */
  managersRoute.post('/:id/trigger', async (c) => {
    return withOwnedManager(c, async ({ id, manager }) => {
      const config = parseManagerConfig(manager.config) as { decisionInterval?: string };
      const decisionInterval = normalizeManagerDecisionInterval(config.decisionInterval);
      try {
        await triggerManagerDo(c.env, id, decisionInterval);
      } catch (err) {
        if (err instanceof DoRequestError) {
          return c.json({ error: err.body || err.message }, err.status as 400 | 409 | 500);
        }
        return c.json({ error: err instanceof Error ? err.message : 'Failed to trigger' }, 409);
      }
      return c.json({ ok: true });
    });
  });
}
