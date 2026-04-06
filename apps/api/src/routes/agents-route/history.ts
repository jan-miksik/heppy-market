import { desc, eq } from 'drizzle-orm';
import { agentDecisions, performanceSnapshots, trades } from '../../db/schema.js';
import { withOwnedAgent } from './shared.js';
import type { AgentsRoute } from './shared.js';

export function registerAgentHistoryRoutes(agentsRoute: AgentsRoute): void {
  /** GET /api/agents/:id/trades */
  agentsRoute.get('/:id/trades', async (c) => {
    return withOwnedAgent(c, async ({ id, db }) => {
      const agentTrades = await db
        .select()
        .from(trades)
        .where(eq(trades.agentId, id))
        .orderBy(desc(trades.openedAt));
      return c.json({ trades: agentTrades });
    });
  });

  /** GET /api/agents/:id/decisions */
  agentsRoute.get('/:id/decisions', async (c) => {
    return withOwnedAgent(c, async ({ id, db }) => {
      const decisions = await db
        .select()
        .from(agentDecisions)
        .where(eq(agentDecisions.agentId, id))
        .orderBy(desc(agentDecisions.createdAt));
      return c.json({ decisions });
    });
  });

  /** GET /api/agents/:id/performance */
  agentsRoute.get('/:id/performance', async (c) => {
    return withOwnedAgent(c, async ({ id, db }) => {
      const snapshots = await db
        .select()
        .from(performanceSnapshots)
        .where(eq(performanceSnapshots.agentId, id))
        .orderBy(desc(performanceSnapshots.snapshotAt));
      return c.json({ snapshots });
    });
  });
}
