import { drizzle } from 'drizzle-orm/d1';
import { eq } from 'drizzle-orm';
import type { Env } from '../../types/env.js';
import { agents } from '../../db/schema.js';
import { agentManagers } from '../../db/schema.js';
import { getDefaultManagerMaxAgents, getMaxAgentsPerUser } from '../../lib/entity-limits.js';
import { generateId, nowIso } from '../../lib/utils.js';
import { normalizePairsForDex } from '../../lib/pairs.js';
import {
  pauseTradingAgentDo,
  setTradingAgentIntervalDo,
  startTradingAgentDo,
  stopTradingAgentDo,
  syncTradingAgentConfigDo,
} from '../../lib/do-clients.js';
import {
  AGENT_PROFILES,
  DEFAULT_FREE_AGENT_MODEL,
  buildManagerAllowedAgentModelSet,
  filterSupportedBasePairs,
  getAgentPersonaTemplate,
  getDefaultAgentPersona,
  normalizeTradingInterval,
} from '@something-in-loop/shared';
import type { ManagerDecision } from './types.js';

const MANAGER_DISALLOWED_AGENT_PARAMS = new Set([
  'chain',
  'isPaper',
  'initiaWalletAddress',
  'initiaMetadataHash',
  'initiaMetadataVersion',
  'onchainAgentId',
  'initiaSyncState',
  'initiaLinkTxHash',
  'initiaLinkedAt',
]);

function buildAllowedAgentModels(hasUserOpenRouterKey: boolean): Set<string> {
  return buildManagerAllowedAgentModelSet(hasUserOpenRouterKey);
}

function normaliseAgentModel(requested: unknown, allowedModels: Set<string>): string {
  const fallback = DEFAULT_FREE_AGENT_MODEL;
  if (typeof requested !== 'string') return fallback;
  return allowedModels.has(requested) ? requested : fallback;
}

export function normalizeManagerAnalysisInterval(value: unknown, fallback: string = '1h'): string {
  return normalizeTradingInterval(value, normalizeTradingInterval(fallback, '1h'));
}

function isPaperAgentRow(agent: { isPaper?: boolean | null; config: string }): boolean {
  if (agent.isPaper === true) return true;
  try {
    const parsed = JSON.parse(agent.config) as { isPaper?: unknown };
    return parsed.isPaper === true;
  } catch {
    return false;
  }
}

function sanitizeManagerAgentParams(params: Record<string, unknown>): Record<string, unknown> {
  const sanitized = { ...params };
  for (const key of MANAGER_DISALLOWED_AGENT_PARAMS) {
    delete sanitized[key];
  }
  return sanitized;
}

/** Execute a single manager decision against D1 + DO stubs */
export async function executeManagerAction(
  decision: ManagerDecision,
  db: ReturnType<typeof drizzle>,
  env: Env,
  managerId: string,
  ownerAddress: string,
  hasUserOpenRouterKey = false,
): Promise<{ success: boolean; detail?: string; error?: string }> {
  const { action, agentId, params } = decision;
  const allowedModels = buildAllowedAgentModels(hasUserOpenRouterKey);

  switch (action) {
    case 'hold':
      return { success: true, detail: 'No action taken' };

    case 'start_agent': {
      if (!agentId) return { success: false, error: 'start_agent requires agentId' };
      const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
      if (!agent) return { success: false, error: `Agent ${agentId} not found` };
      if (!isPaperAgentRow(agent)) {
        return { success: false, error: `Manager ${managerId} can only control paper agents` };
      }
      if (agent.status === 'running') return { success: true, detail: `Agent ${agentId} already running` };
      const agentConfig = JSON.parse(agent.config) as {
        paperBalance?: number;
        slippageSimulation?: number;
        analysisInterval?: string;
      };
      await startTradingAgentDo(env, {
        agentId,
        paperBalance: agentConfig.paperBalance ?? 10000,
        slippageSimulation: agentConfig.slippageSimulation ?? 0.3,
        analysisInterval: agentConfig.analysisInterval ?? '1h',
      });
      await db.update(agents).set({ status: 'running', updatedAt: nowIso() }).where(eq(agents.id, agentId));
      return { success: true, detail: `Agent ${agentId} started` };
    }

    case 'pause_agent': {
      if (!agentId) return { success: false, error: 'pause_agent requires agentId' };
      const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
      if (!agent) return { success: false, error: `Agent ${agentId} not found` };
      if (!isPaperAgentRow(agent)) {
        return { success: false, error: `Manager ${managerId} can only control paper agents` };
      }
      if (agent.status === 'running') {
        await pauseTradingAgentDo(env, agentId);
      }
      await db.update(agents).set({ status: 'paused', updatedAt: nowIso() }).where(eq(agents.id, agentId));
      return { success: true, detail: `Agent ${agentId} paused` };
    }

    case 'terminate_agent': {
      if (!agentId) return { success: false, error: 'terminate_agent requires agentId' };
      const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
      if (!agent) return { success: false, error: `Agent ${agentId} not found` };
      if (!isPaperAgentRow(agent)) {
        return { success: false, error: `Manager ${managerId} can only control paper agents` };
      }
      if (agent.status === 'running' || agent.status === 'paused') {
        await stopTradingAgentDo(env, agentId);
      }
      await db
        .update(agents)
        .set({ status: 'stopped', managerId: null, updatedAt: nowIso() })
        .where(eq(agents.id, agentId));
      return { success: true, detail: `Agent ${agentId} terminated` };
    }

    case 'modify_agent': {
      if (!agentId || !params) return { success: false, error: 'modify_agent requires agentId and params' };
      const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
      if (!agent) return { success: false, error: `Agent ${agentId} not found` };
      if (!isPaperAgentRow(agent)) {
        return { success: false, error: `Manager ${managerId} can only control paper agents` };
      }
      const existingConfig = JSON.parse(agent.config);
      const previousAnalysisInterval = normalizeManagerAnalysisInterval(existingConfig.analysisInterval, '1h');
      const sanitizedParams = sanitizeManagerAgentParams(params as Record<string, unknown>);
      const { personaMd: paramsPersona, ...restParams } = sanitizedParams as Record<string, unknown> & { personaMd?: string };
      const patch: Record<string, unknown> = { ...restParams };
      if (typeof patch.llmModel === 'string') {
        patch.llmModel = normaliseAgentModel(patch.llmModel, allowedModels);
      }
      if (patch.analysisInterval !== undefined) {
        patch.analysisInterval = normalizeManagerAnalysisInterval(patch.analysisInterval, previousAnalysisInterval);
      }
      if (patch.pairs != null && Array.isArray(patch.pairs)) {
        const normalized = normalizePairsForDex(patch.pairs as string[]);
        const supported = filterSupportedBasePairs(normalized);
        if (supported.length > 0) {
          patch.pairs = supported;
        } else {
          delete (patch as any).pairs;
        }
      }
      const mergedConfig = { ...existingConfig, ...patch };
      const nextAnalysisInterval = normalizeManagerAnalysisInterval(mergedConfig.analysisInterval, previousAnalysisInterval);
      mergedConfig.isPaper = true;
      mergedConfig.chain = 'base';
      delete mergedConfig.initiaWalletAddress;
      delete mergedConfig.initiaMetadataHash;
      delete mergedConfig.initiaMetadataVersion;
      mergedConfig.analysisInterval = nextAnalysisInterval;
      const analysisIntervalChanged = nextAnalysisInterval !== previousAnalysisInterval;
      const updates: Partial<typeof agents.$inferInsert> = {
        chain: 'base',
        isPaper: true,
        config: JSON.stringify(mergedConfig),
        llmModel: (mergedConfig.llmModel ?? agent.llmModel) || DEFAULT_FREE_AGENT_MODEL,
        updatedAt: nowIso(),
      };
      if (paramsPersona !== undefined) {
        updates.personaMd = typeof paramsPersona === 'string' ? paramsPersona : null;
      }
      await db.update(agents).set(updates).where(eq(agents.id, agentId));
      const [updatedAgent] = await db.select().from(agents).where(eq(agents.id, agentId));

      if (agent.status === 'running' && updatedAgent) {
        try {
          await syncTradingAgentConfigDo(env, agentId, {
            id: updatedAgent.id,
            name: updatedAgent.name,
            status: updatedAgent.status,
            config: updatedAgent.config,
            ownerAddress: updatedAgent.ownerAddress ?? null,
            llmModel: updatedAgent.llmModel ?? null,
            profileId: updatedAgent.profileId ?? null,
            personaMd: updatedAgent.personaMd ?? null,
          });
        } catch (err) {
          console.warn(`[manager-loop] failed to sync config cache to TRADING_AGENT DO for ${agentId}:`, err);
        }

        if (analysisIntervalChanged) {
          try {
            await setTradingAgentIntervalDo(env, agentId, nextAnalysisInterval);
          } catch (err) {
            console.warn(`[manager-loop] failed to sync interval to TRADING_AGENT DO for ${agentId}:`, err);
          }
        }
      }
      return { success: true, detail: `Agent ${agentId} modified` };
    }

    case 'create_agent': {
      if (!params) return { success: false, error: 'create_agent requires params' };
      const [manager] = await db.select().from(agentManagers).where(eq(agentManagers.id, managerId));
      if (!manager) return { success: false, error: `Manager ${managerId} not found` };

      const totalOwnedAgents = await db
        .select({ id: agents.id })
        .from(agents)
        .where(eq(agents.ownerAddress, ownerAddress));
      const maxAgentsPerUser = getMaxAgentsPerUser(env);
      if (maxAgentsPerUser !== null && totalOwnedAgents.length >= maxAgentsPerUser) {
        return { success: false, error: `Owner ${ownerAddress} reached the max agent limit (${maxAgentsPerUser})` };
      }

      const managerConfig = JSON.parse(manager.config) as { riskParams?: { maxAgents?: unknown } };
      const configuredMaxAgents = managerConfig.riskParams?.maxAgents;
      const maxManagedAgents =
        typeof configuredMaxAgents === 'number' && Number.isFinite(configuredMaxAgents) && configuredMaxAgents >= 1
          ? configuredMaxAgents
          : getDefaultManagerMaxAgents(env);
      const existingManagedAgents = await db
        .select({ id: agents.id })
        .from(agents)
        .where(eq(agents.managerId, managerId));
      if (existingManagedAgents.length >= maxManagedAgents) {
        return { success: false, error: `Manager ${managerId} reached the max managed agent limit (${maxManagedAgents})` };
      }

      const sanitizedParams = sanitizeManagerAgentParams(params as Record<string, unknown>);
      const agentName = String(sanitizedParams.name ?? 'Manager-created Paper Agent');
      const paperBalance = Number(sanitizedParams.paperBalance ?? 10000);
      const slippageSimulation = 0.3;
      const analysisInterval = normalizeManagerAnalysisInterval(sanitizedParams.analysisInterval, '1h');
      const llmModel = normaliseAgentModel(sanitizedParams.llmModel, allowedModels);
      const validAgentProfileIds = new Set(AGENT_PROFILES.map((p) => p.id));
      const llmProfileId = typeof sanitizedParams.profileId === 'string' ? sanitizedParams.profileId : null;
      const profileId = llmProfileId && validAgentProfileIds.has(llmProfileId) ? llmProfileId : null;
      const personaMd =
        typeof sanitizedParams.personaMd === 'string' && sanitizedParams.personaMd.trim()
          ? sanitizedParams.personaMd.trim()
          : profileId
            ? getAgentPersonaTemplate(profileId, agentName)
            : getDefaultAgentPersona(agentName);
      const normalizedPairs = normalizePairsForDex((sanitizedParams.pairs as string[] | undefined) ?? ['INIT/USD']);
      const supportedPairs = filterSupportedBasePairs(normalizedPairs);
      const config = {
        name: agentName,
        llmModel,
        temperature: sanitizedParams.temperature ?? 0.7,
        pairs: supportedPairs.length > 0 ? supportedPairs : ['INIT/USD'],
        analysisInterval,
        strategies: sanitizedParams.strategies ?? ['combined'],
        isPaper: true,
        paperBalance,
        maxPositionSizePct: sanitizedParams.maxPositionSizePct ?? 5,
        maxOpenPositions: sanitizedParams.maxOpenPositions ?? 3,
        stopLossPct: sanitizedParams.stopLossPct ?? 5,
        takeProfitPct: sanitizedParams.takeProfitPct ?? 7,
        slippageSimulation,
        maxDailyLossPct: sanitizedParams.maxDailyLossPct ?? 10,
        cooldownAfterLossMinutes: sanitizedParams.cooldownAfterLossMinutes ?? 30,
        chain: 'base',
        dexes: ['aerodrome', 'uniswap-v3'],
        maxLlmCallsPerHour: 12,
        allowFallback: false,
        llmFallback: DEFAULT_FREE_AGENT_MODEL,
      };
      const id = generateId('agent');
      const now = nowIso();
      await db.insert(agents).values({
        id,
        name: agentName,
        status: 'running',
        autonomyLevel: 2,
        chain: 'base',
        isPaper: true,
        config: JSON.stringify(config),
        llmModel,
        ownerAddress,
        managerId,
        personaMd,
        profileId,
        createdAt: now,
        updatedAt: now,
      });
      await startTradingAgentDo(env, {
        agentId: id,
        paperBalance,
        slippageSimulation,
        analysisInterval,
      });
      return { success: true, detail: `Agent ${id} created and started` };
    }

    default:
      return { success: false, error: `Unknown action: ${String(action)}` };
  }
}
