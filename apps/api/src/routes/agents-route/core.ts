import { drizzle } from 'drizzle-orm/d1';
import { desc, eq } from 'drizzle-orm';
import {
  CreateAgentRequestSchema,
  DEFAULT_FREE_AGENT_MODEL,
  UpdateAgentRequestSchema,
  resolveAgentProfileId,
} from '@something-in-loop/shared';
import { agents } from '../../db/schema.js';
import { normalizePairsForDex } from '../../lib/pairs.js';
import { nowIso, generateId } from '../../lib/utils.js';
import { validateBody } from '../../lib/validation.js';
import { setTradingAgentIntervalDo, stopTradingAgentDo, syncTradingAgentConfigDo } from '../../lib/do-clients.js';
import { deleteAgentRelatedRows, formatAgent, notifyScheduler, normalizeInitiaWalletAddress, parseAgentConfig, withOwnedAgent } from './shared.js';
import type { AgentsRoute } from './shared.js';

export function registerAgentCoreRoutes(agentsRoute: AgentsRoute): void {
  /** GET /api/agents — list agents owned by the authenticated user */
  agentsRoute.get('/', async (c) => {
    const walletAddress = c.get('walletAddress');
    const db = drizzle(c.env.DB);
    const rows = await db
      .select()
      .from(agents)
      .where(eq(agents.ownerAddress, walletAddress))
      .orderBy(desc(agents.createdAt));
    return c.json({ agents: rows.map(formatAgent) });
  });

  /** POST /api/agents — create agent, scoped to authenticated user */
  agentsRoute.post('/', async (c) => {
    const body = await validateBody(c, CreateAgentRequestSchema);
    const walletAddress = c.get('walletAddress');
    const db = drizzle(c.env.DB);

    const chain = body.chain ?? 'base';
    const initiaWalletAddress = normalizeInitiaWalletAddress(body.initiaWalletAddress);

    const id = generateId('agent');
    const now = nowIso();
    const config = {
      ...body,
      ...(typeof body.profileId === 'string' && { profileId: resolveAgentProfileId(body.profileId) }),
      pairs: normalizePairsForDex(body.pairs),
    };

    const profileId = typeof body.profileId === 'string' ? resolveAgentProfileId(body.profileId) : null;

    await db.insert(agents).values({
      id,
      name: body.name,
      status: 'stopped',
      autonomyLevel: 2,
      chain,
      config: JSON.stringify(config),
      llmModel: body.llmModel,
      ownerAddress: walletAddress,
      profileId,
      personaMd: body.personaMd ?? null,
      initiaWalletAddress: chain === 'initia' ? initiaWalletAddress : null,
      initiaMetadataHash: body.initiaMetadataHash ?? null,
      initiaMetadataVersion: body.initiaMetadataVersion ?? null,
      createdAt: now,
      updatedAt: now,
    });

    const [created] = await db.select().from(agents).where(eq(agents.id, id));
    return c.json(formatAgent(created), 201);
  });

  /** GET /api/agents/:id — get single agent */
  agentsRoute.get('/:id', async (c) => {
    return withOwnedAgent(c, async ({ agent }) => c.json(formatAgent(agent)));
  });

  /** PATCH /api/agents/:id — update agent config */
  agentsRoute.patch('/:id', async (c) => {
    const body = await validateBody(c, UpdateAgentRequestSchema);

    return withOwnedAgent(c, async ({ id, db, agent: existing }) => {
      // Optional optimistic lock: client passes the updatedAt it last saw
      const clientVersion = typeof (body as { _version?: unknown })._version === 'string'
        ? (body as { _version?: string })._version
        : null;
      if (clientVersion && existing.updatedAt !== clientVersion) {
        return c.json(
          { error: 'Conflict: agent was modified by another request. Reload and retry.', code: 'VERSION_CONFLICT' },
          409
        );
      }

      const existingConfig = parseAgentConfig(existing.config);
      const existingChain = existing.chain ?? (typeof existingConfig.chain === 'string' ? existingConfig.chain : 'base');
      const nextChain = typeof body.chain === 'string' ? body.chain : existingChain;
      const nextInitiaWalletAddress = body.initiaWalletAddress !== undefined
        ? normalizeInitiaWalletAddress(body.initiaWalletAddress)
        : normalizeInitiaWalletAddress(existing.initiaWalletAddress);

      const mergedConfig = {
        ...existingConfig,
        ...body,
        chain: nextChain,
        ...(nextInitiaWalletAddress ? { initiaWalletAddress: nextInitiaWalletAddress } : {}),
        ...(typeof body.profileId === 'string' && { profileId: resolveAgentProfileId(body.profileId) }),
        ...(body.pairs !== undefined && { pairs: normalizePairsForDex(body.pairs) }),
      };

      const prevInterval = existingConfig.analysisInterval;
      const nextInterval = mergedConfig.analysisInterval;
      const intervalChanged =
        typeof nextInterval === 'string' &&
        nextInterval.trim().length > 0 &&
        nextInterval !== prevInterval;

      const updates: Partial<typeof agents.$inferInsert> = {
        chain: nextChain,
        config: JSON.stringify(mergedConfig),
        updatedAt: nowIso(),
      };
      if (body.name) updates.name = body.name;
      // Always sync llm_model column from merged config so the agent loop uses the selected model
      updates.llmModel = (typeof mergedConfig.llmModel === 'string' ? mergedConfig.llmModel : existing.llmModel) || DEFAULT_FREE_AGENT_MODEL;
      if (body.profileId !== undefined) {
        updates.profileId = typeof body.profileId === 'string' ? resolveAgentProfileId(body.profileId) : body.profileId ?? null;
      }
      if (body.personaMd !== undefined) updates.personaMd = body.personaMd ?? null;
      if (body.initiaWalletAddress !== undefined) updates.initiaWalletAddress = nextInitiaWalletAddress;
      if (body.initiaMetadataHash !== undefined) updates.initiaMetadataHash = body.initiaMetadataHash ?? null;
      if (body.initiaMetadataVersion !== undefined) updates.initiaMetadataVersion = body.initiaMetadataVersion ?? null;

      await db.update(agents).set(updates).where(eq(agents.id, id));

      const [updated] = await db.select().from(agents).where(eq(agents.id, id));

      // Best-effort: push updated config to the DO cache so runAgentLoop picks it up immediately.
      if (updated) {
        try {
          await syncTradingAgentConfigDo(c.env, id, {
            id: updated.id,
            name: updated.name,
            status: updated.status,
            config: updated.config,
            ownerAddress: updated.ownerAddress ?? null,
            llmModel: updated.llmModel ?? null,
            profileId: updated.profileId ?? null,
            personaMd: updated.personaMd ?? null,
          });
        } catch (err) {
          console.warn(`[agents route] Failed to push config to TRADING_AGENT DO cache for ${id}:`, err);
        }
      }

      // Best-effort: if the agent is currently running, sync the DO alarm interval immediately.
      if (intervalChanged && existing.status === 'running') {
        try {
          await setTradingAgentIntervalDo(c.env, id, String(nextInterval));
        } catch (err) {
          console.warn(`[agents route] Failed to sync analysisInterval to TRADING_AGENT DO for ${id}:`, err);
        }
        // Also update the scheduler registry with the new interval
        await notifyScheduler(c.env, 'register', id, nextInterval);
      }

      return c.json({
        ...formatAgent(updated),
        pendingRestart: existing.status === 'running',
      });
    });
  });

  /** DELETE /api/agents/:id — delete agent (stops first if running) */
  agentsRoute.delete('/:id', async (c) => {
    return withOwnedAgent(c, async ({ id, db, agent: existing }) => {
      if (existing.status === 'running' || existing.status === 'paused') {
        try {
          await stopTradingAgentDo(c.env, id);
        } catch (err) {
          console.error('[agents route] Failed to stop TRADING_AGENT DO before delete', err);
        }
        await db.update(agents).set({ status: 'stopped', updatedAt: nowIso() }).where(eq(agents.id, id));
      }

      await notifyScheduler(c.env, 'unregister', id);

      await deleteAgentRelatedRows(db, id);
      await db.delete(agents).where(eq(agents.id, id));
      return c.json({ ok: true });
    });
  });
}
