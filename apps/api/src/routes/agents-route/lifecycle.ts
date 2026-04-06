import { eq } from 'drizzle-orm';
import { agents, users } from '../../db/schema.js';
import { nowIso } from '../../lib/utils.js';
import { pauseTradingAgentDo, startTradingAgentDo, stopTradingAgentDo } from '../../lib/do-clients.js';
import { deleteAgentRelatedRows, getTradingAgentStub, notifyScheduler, parseAgentConfig, withOwnedAgent } from './shared.js';
import type { AgentsRoute } from './shared.js';

export function registerAgentLifecycleRoutes(agentsRoute: AgentsRoute): void {
  /** POST /api/agents/:id/start — start agent */
  agentsRoute.post('/:id/start', async (c) => {
    return withOwnedAgent(c, async ({ id, db, agent }) => {
      if (agent.status === 'running') {
        return c.json({ ok: true, status: 'running', message: 'Already running' });
      }

      const agentConfig = parseAgentConfig(agent.config) as {
        paperBalance: number;
        slippageSimulation: number;
        analysisInterval: string;
      };

      await startTradingAgentDo(c.env, {
        agentId: id,
        paperBalance: agentConfig.paperBalance,
        slippageSimulation: agentConfig.slippageSimulation,
        analysisInterval: agentConfig.analysisInterval,
        agentRow: {
          id: agent.id,
          name: agent.name,
          status: 'running', // will be set running momentarily
          config: agent.config,
          ownerAddress: agent.ownerAddress ?? null,
          llmModel: agent.llmModel ?? null,
          profileId: agent.profileId ?? null,
          personaMd: agent.personaMd ?? null,
        },
      });

      await db.update(agents).set({ status: 'running', updatedAt: nowIso() }).where(eq(agents.id, id));

      // Register with global scheduler so cron handler doesn't need to scan D1
      await notifyScheduler(c.env, 'register', id, agentConfig.analysisInterval ?? '1h');

      return c.json({ ok: true, status: 'running' });
    });
  });

  /** POST /api/agents/:id/reset */
  agentsRoute.post('/:id/reset', async (c) => {
    return withOwnedAgent(c, async ({ id, db, agent }) => {
      const config = parseAgentConfig(agent.config) as { paperBalance?: number; slippageSimulation?: number };
      const stub = getTradingAgentStub(c.env, id);
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
  });

  /** POST /api/agents/:id/stop */
  agentsRoute.post('/:id/stop', async (c) => {
    return withOwnedAgent(c, async ({ id, db }) => {
      await stopTradingAgentDo(c.env, id);
      await db.update(agents).set({ status: 'stopped', updatedAt: nowIso() }).where(eq(agents.id, id));

      await notifyScheduler(c.env, 'unregister', id);
      return c.json({ ok: true, status: 'stopped' });
    });
  });

  /** POST /api/agents/:id/pause */
  agentsRoute.post('/:id/pause', async (c) => {
    return withOwnedAgent(c, async ({ id, db }) => {
      await pauseTradingAgentDo(c.env, id);
      await db.update(agents).set({ status: 'paused', updatedAt: nowIso() }).where(eq(agents.id, id));

      await notifyScheduler(c.env, 'unregister', id);
      return c.json({ ok: true, status: 'paused' });
    });
  });

  /** POST /api/agents/:id/history/clear — delete all trading history for this agent */
  agentsRoute.post('/:id/history/clear', async (c) => {
    return withOwnedAgent(c, async ({ id, db, agent }) => {
      // Clear Durable Object engine state first to avoid "phantom" open positions lingering in memory.
      try {
        const agentConfig = parseAgentConfig(agent.config) as {
          paperBalance?: number;
          slippageSimulation?: number;
          analysisInterval?: string;
        };
        const stub = getTradingAgentStub(c.env, id);
        const res = await stub.fetch(
          new Request('http://do/clear-history', {
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
          const body = (await res.json().catch(() => null)) as { error?: string } | null;
          return c.json({ error: body?.error ?? 'Failed to clear agent engine state' }, 500);
        }
      } catch (err) {
        return c.json({ error: `Failed to clear agent engine state: ${String(err)}` }, 500);
      }

      await deleteAgentRelatedRows(db, id);
      return c.json({ ok: true });
    });
  });

  /** POST /api/agents/:id/analyze */
  agentsRoute.post('/:id/analyze', async (c) => {
    if (!c.env.OPENROUTER_API_KEY) {
      return c.json(
        { error: 'OPENROUTER_API_KEY is not configured. Add it to .dev.vars (local) or Cloudflare secrets (production).' },
        503
      );
    }

    return withOwnedAgent(c, async ({ id, agent }) => {
      const agentConfig = parseAgentConfig(agent.config) as {
        paperBalance: number;
        slippageSimulation: number;
        analysisInterval: string;
      };
      const stub = getTradingAgentStub(c.env, id);

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
        // Preserve 409 (lock contention) — don't flatten all DO errors to 500
        const status = res.status === 409 ? 409 : 500;
        return c.json({ error: body.error ?? 'Analysis failed' }, status);
      }
      return c.json({ ok: true });
    });
  });

  /** GET /api/agents/:id/debug — returns DO internal state (tester/admin only) */
  agentsRoute.get('/:id/debug', async (c) => {
    return withOwnedAgent(c, async ({ id, walletAddress, db }) => {
      // Gate to tester role
      const [ownerUser] = await db
        .select({ role: users.role })
        .from(users)
        .where(eq(users.walletAddress, walletAddress));
      if (ownerUser?.role !== 'tester') {
        return c.json({ error: 'Forbidden: debug endpoint requires tester role' }, 403);
      }

      const stub = getTradingAgentStub(c.env, id);
      const res = await stub.fetch(new Request('http://do/debug'));
      if (!res.ok) {
        return c.json({ error: 'Failed to fetch debug state from agent' }, 502);
      }
      const debugState = await res.json();
      return c.json(debugState);
    });
  });

  /** GET /api/agents/:id/status */
  agentsRoute.get('/:id/status', async (c) => {
    return withOwnedAgent(c, async ({ id }) => {
      const stub = getTradingAgentStub(c.env, id);
      const res = await stub.fetch(new Request('http://do/status'));
      const doStatus = await res.json<{
        agentId: string | null;
        status: string;
        balance: number | null;
        nextAlarmAt: number | null;
      }>();
      return c.json(doStatus);
    });
  });
}
