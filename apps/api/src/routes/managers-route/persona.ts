import { eq } from 'drizzle-orm';
import { UpdatePersonaSchema, getManagerPersonaTemplate } from '@something-in-loop/shared';
import { agentManagers } from '../../db/schema.js';
import { nowIso } from '../../lib/utils.js';
import { validateBody } from '../../lib/validation.js';
import { parseManagerConfig, withOwnedManager } from './shared.js';
import type { ManagersRoute } from './shared.js';

export function registerManagerPersonaRoutes(managersRoute: ManagersRoute): void {
  /** GET /api/managers/:id/persona */
  managersRoute.get('/:id/persona', async (c) => {
    return withOwnedManager(c, async ({ manager }) => (
      c.json({ personaMd: manager.personaMd ?? null, profileId: manager.profileId ?? null })
    ));
  });

  /** PUT /api/managers/:id/persona */
  managersRoute.put('/:id/persona', async (c) => {
    const body = await validateBody(c, UpdatePersonaSchema);
    return withOwnedManager(c, async ({ id, db }) => {
      await db.update(agentManagers).set({ personaMd: body.personaMd, updatedAt: nowIso() }).where(eq(agentManagers.id, id));
      return c.json({ ok: true, personaMd: body.personaMd });
    });
  });

  /** POST /api/managers/:id/persona/reset */
  managersRoute.post('/:id/persona/reset', async (c) => {
    return withOwnedManager(c, async ({ id, db, manager }) => {
      const config = parseManagerConfig(manager.config) as { profileId?: string };
      const profileId = config.profileId ?? manager.profileId ?? 'passive_index';
      const personaMd = getManagerPersonaTemplate(profileId, manager.name);
      await db.update(agentManagers).set({ personaMd, updatedAt: nowIso() }).where(eq(agentManagers.id, id));
      return c.json({ ok: true, personaMd });
    });
  });
}
