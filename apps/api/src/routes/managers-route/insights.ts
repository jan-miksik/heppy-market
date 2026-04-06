import { desc, eq, inArray, sql } from 'drizzle-orm';
import { agentDecisions, agentManagerLogs, agents } from '../../db/schema.js';
import { parseJsonRequired } from '../../lib/json.js';
import { safeParseManagerLogResult, withOwnedManager } from './shared.js';
import type { ManagersRoute } from './shared.js';

export function registerManagerInsightRoutes(managersRoute: ManagersRoute): void {
  /** GET /api/managers/:id/logs */
  managersRoute.get('/:id/logs', async (c) => {
    return withOwnedManager(c, async ({ id, db }) => {
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
        logs: logs.map((l) => ({ ...l, result: safeParseManagerLogResult(l.result) })),
        page,
        limit,
      });
    });
  });

  /** GET /api/managers/:id/prompt-preview — returns the full prompt from the last decision cycle (if any) */
  managersRoute.get('/:id/prompt-preview', async (c) => {
    return withOwnedManager(c, async ({ id, db }) => {
      const [log] = await db
        .select()
        .from(agentManagerLogs)
        .where(eq(agentManagerLogs.managerId, id))
        .orderBy(desc(agentManagerLogs.createdAt))
        .limit(1);

      let promptText: string | null = null;
      if (log?.result) {
        const parsed = safeParseManagerLogResult(log.result);
        promptText = typeof parsed?.llmPromptText === 'string' ? parsed.llmPromptText : null;
      }

      return c.json({
        promptText,
        promptAt: log?.createdAt ?? null,
      });
    });
  });

  /** GET /api/managers/:id/agents */
  managersRoute.get('/:id/agents', async (c) => {
    return withOwnedManager(c, async ({ id, db }) => {
      const managedAgents = await db.select().from(agents).where(eq(agents.managerId, id));
      return c.json({
        agents: managedAgents.map((r) => ({
          ...r,
          config: parseJsonRequired<Record<string, unknown>>(r.config),
        })),
      });
    });
  });

  /** GET /api/managers/:id/token-usage — aggregate LLM tokens used by all managed agents */
  managersRoute.get('/:id/token-usage', async (c) => {
    return withOwnedManager(c, async ({ id, db }) => {
      const managedAgents = await db.select({ id: agents.id }).from(agents).where(eq(agents.managerId, id));
      if (managedAgents.length === 0) {
        return c.json({ totalTokens: 0 });
      }

      const agentIds = managedAgents.map((a) => a.id);
      const [row] = await db
        .select({
          totalTokens: sql<number>`COALESCE(SUM(${agentDecisions.llmTokensUsed}), 0)`,
        })
        .from(agentDecisions)
        .where(inArray(agentDecisions.agentId, agentIds));

      return c.json({ totalTokens: row?.totalTokens ?? 0 });
    });
  });
}
