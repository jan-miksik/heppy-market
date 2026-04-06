import { desc, eq } from 'drizzle-orm';
import { agentSelfModifications, agents } from '../../db/schema.js';
import { nowIso } from '../../lib/utils.js';
import { parseJsonRequired } from '../../lib/json.js';
import { parseAgentConfig, withOwnedAgent } from './shared.js';
import type { AgentsRoute } from './shared.js';

export function registerAgentSelfModificationRoutes(agentsRoute: AgentsRoute): void {
  /** GET /api/agents/:id/self-modifications */
  agentsRoute.get('/:id/self-modifications', async (c) => {
    return withOwnedAgent(c, async ({ id, db }) => {
      const modifications = await db
        .select()
        .from(agentSelfModifications)
        .where(eq(agentSelfModifications.agentId, id))
        .orderBy(desc(agentSelfModifications.createdAt));

      return c.json({
        modifications: modifications.map((m) => ({
          ...m,
          changes: parseJsonRequired<Record<string, unknown>>(m.changes),
          changesApplied: m.changesApplied ? parseJsonRequired<Record<string, unknown>>(m.changesApplied) : null,
        })),
      });
    });
  });

  /** POST /api/agents/:id/self-modifications/:modId/approve */
  agentsRoute.post('/:id/self-modifications/:modId/approve', async (c) => {
    return withOwnedAgent(c, async ({ id, db, agent }) => {
      const modId = c.req.param('modId');

      const [mod] = await db
        .select()
        .from(agentSelfModifications)
        .where(eq(agentSelfModifications.id, modId));
      if (!mod || mod.agentId !== id) return c.json({ error: 'Modification not found' }, 404);

      const changes = parseJsonRequired<Record<string, unknown>>(mod.changes);
      const existingConfig = parseAgentConfig(agent.config);
      const mergedConfig = { ...existingConfig, ...changes };

      await db.update(agents).set({ config: JSON.stringify(mergedConfig), updatedAt: nowIso() }).where(eq(agents.id, id));
      await db
        .update(agentSelfModifications)
        .set({ status: 'applied', changesApplied: mod.changes, appliedAt: nowIso() })
        .where(eq(agentSelfModifications.id, modId));

      return c.json({ ok: true });
    });
  });

  /** POST /api/agents/:id/self-modifications/:modId/reject */
  agentsRoute.post('/:id/self-modifications/:modId/reject', async (c) => {
    return withOwnedAgent(c, async ({ id, db }) => {
      const modId = c.req.param('modId');

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
  });
}
