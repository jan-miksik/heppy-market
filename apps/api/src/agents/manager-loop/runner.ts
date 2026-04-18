import { drizzle } from 'drizzle-orm/d1';
import { desc, eq, inArray, sql } from 'drizzle-orm';
import { generateText } from 'ai';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import type { Env } from '../../types/env.js';
import { agentManagerLogs, agentManagers, agents, performanceSnapshots, trades, users } from '../../db/schema.js';
import { resolveStoredOpenRouterKey } from '../../lib/openrouter-key.js';
import { createDexDataService, getPriceUsd } from '../../services/dex-data.js';
import { createGeckoTerminalService } from '../../services/gecko-terminal.js';
import {
  hasIndexedSpotPriceProvider,
  resolveIndexedGeckoTerminalMarketContextForPair,
  resolveCoinGeckoMarketContextForPair,
  resolveCoinPaprikaMarketContextForPair,
  resolveDemoMarketContextForPair,
} from '../../services/coingecko-price.js';
import { generateId, nowIso } from '../../lib/utils.js';
import { normalizeManagerDecisionInterval } from '../../lib/manager-interval-sync.js';
import type { ManagerConfig } from '@something-in-loop/shared';
import { buildManagerPrompt } from './prompt.js';
import { parseManagerDecisions } from './parsing.js';
import { executeManagerAction } from './actions.js';
import type { ManagedAgentSnapshot, ManagerMemory } from './types.js';

const MANAGER_LLM_TIMEOUT_MS = 60_000; // generous for manager's larger prompt

/** Run one full manager decision cycle */
export async function runManagerLoop(managerId: string, env: Env, ctx: DurableObjectState): Promise<void> {
  const db = drizzle(env.DB);
  // Manager always needs fresh market data — stale KV cache would produce
  // outdated prices for a decision that may reconfigure running agents.
  const bypassCache = true;
  try {
    await db.run(sql`PRAGMA foreign_keys = ON`);
  } catch {
    // non-fatal
  }

  const [managerRow] = await db.select().from(agentManagers).where(eq(agentManagers.id, managerId));
  if (!managerRow) {
    console.log(`[manager-loop] Manager ${managerId} not found`);
    return;
  }
  if (managerRow.status !== 'running') {
    console.log(`[manager-loop] Manager ${managerId} not running (status=${managerRow.status}), skipping`);
    return;
  }

  const config = JSON.parse(managerRow.config) as ManagerConfig;
  const runtimeDecisionInterval = normalizeManagerDecisionInterval((config as { decisionInterval?: string }).decisionInterval);
  try {
    await ctx.storage.put('decisionInterval', runtimeDecisionInterval);
  } catch (err) {
    console.warn(`[manager-loop] ${managerId}: failed to sync decisionInterval into DO storage:`, err);
  }

  const managedRows = await db.select().from(agents).where(eq(agents.managerId, managerId));

  const agentSnapshots: ManagedAgentSnapshot[] = [];

  if (managedRows.length > 0) {
    const agentIds = managedRows.map((r) => r.id);

    const allSnapshots = await db
      .select()
      .from(performanceSnapshots)
      .where(inArray(performanceSnapshots.agentId, agentIds))
      .orderBy(desc(performanceSnapshots.snapshotAt));

    const latestSnapshotByAgent = new Map<string, (typeof allSnapshots)[number]>();
    for (const snap of allSnapshots) {
      if (!latestSnapshotByAgent.has(snap.agentId)) {
        latestSnapshotByAgent.set(snap.agentId, snap);
      }
    }

    const allRecentTrades = await db
      .select({
        agentId: trades.agentId,
        pair: trades.pair,
        side: trades.side,
        pnlPct: trades.pnlPct,
        openedAt: trades.openedAt,
        closedAt: trades.closedAt,
      })
      .from(trades)
      .where(inArray(trades.agentId, agentIds))
      .orderBy(desc(trades.openedAt));

    const tradesByAgent = new Map<string, typeof allRecentTrades>();
    for (const trade of allRecentTrades) {
      const existing = tradesByAgent.get(trade.agentId) ?? [];
      if (existing.length < 10) existing.push(trade);
      tradesByAgent.set(trade.agentId, existing);
    }

    for (const row of managedRows) {
      const agentConfig = JSON.parse(row.config) as ManagedAgentSnapshot['config'];
      const perfRow = latestSnapshotByAgent.get(row.id);
      const recentTrades = tradesByAgent.get(row.id) ?? [];

      agentSnapshots.push({
        id: row.id,
        name: row.name,
        status: row.status,
        llmModel: row.llmModel,
        config: {
          pairs: agentConfig.pairs ?? [],
          strategies: agentConfig.strategies ?? [],
          maxPositionSizePct: agentConfig.maxPositionSizePct ?? 5,
          analysisInterval: agentConfig.analysisInterval ?? '1h',
          paperBalance: agentConfig.paperBalance ?? 10000,
          temperature: agentConfig.temperature ?? 0.7,
        },
        performance: {
          balance: perfRow?.balance ?? agentConfig.paperBalance ?? 10000,
          totalPnlPct: perfRow?.totalPnlPct ?? 0,
          winRate: perfRow?.winRate ?? 0,
          totalTrades: perfRow?.totalTrades ?? 0,
          sharpeRatio: perfRow?.sharpeRatio ?? null,
          maxDrawdown: perfRow?.maxDrawdown ?? null,
        },
        recentTrades,
      });
    }
  }

  const allPairs = [...new Set(agentSnapshots.flatMap((a) => a.config.pairs))].slice(0, 5);

  const geckoSvc = createGeckoTerminalService(env.CACHE, { bypassCache });
  const dexSvc = createDexDataService(env.CACHE, { bypassCache });
  const marketData: Array<{ pair: string; priceUsd: number; priceChange: Record<string, number | undefined> }> = [];

  for (const pairName of allPairs) {
    const query = pairName.replace('/', ' ');
    const skipDexDiscovery = hasIndexedSpotPriceProvider(pairName);

    if (!skipDexDiscovery) {
      try {
        const pools = await geckoSvc.searchPools(query);
        const pool = pools.find((p: any) => {
          const tokens = pairName.split('/').map((t: string) => t.trim().toUpperCase());
          return tokens.every((t: string) => p.name.toUpperCase().includes(t));
        });
        if (pool && pool.priceUsd > 0) {
          marketData.push({ pair: pairName, priceUsd: pool.priceUsd, priceChange: pool.priceChange });
          continue;
        }
      } catch {
        // fallthrough
      }

      try {
        const results = await dexSvc.searchPairs(query);
        const basePair = results
          .filter((p: any) => p.chainId === 'base')
          .sort((a: any, b: any) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0] as any;
        if (basePair) {
          marketData.push({
            pair: pairName,
            priceUsd: getPriceUsd(basePair),
            priceChange: { h1: basePair.priceChange?.h1, h24: basePair.priceChange?.h24 },
          });
          continue;
        }
      } catch {
        // skip
      }
    }

    const indexedGeckoCtx = await resolveIndexedGeckoTerminalMarketContextForPair(env, pairName, { bypassCache });
    if (indexedGeckoCtx && indexedGeckoCtx.spotUsd > 0) {
      marketData.push({
        pair: pairName,
        priceUsd: indexedGeckoCtx.spotUsd,
        priceChange: indexedGeckoCtx.priceChange,
      });
      continue;
    }

    const coinGeckoCtx = await resolveCoinGeckoMarketContextForPair(env, pairName, { bypassCache });
    if (coinGeckoCtx && coinGeckoCtx.spotUsd > 0) {
      marketData.push({
        pair: pairName,
        priceUsd: coinGeckoCtx.spotUsd,
        priceChange: coinGeckoCtx.priceChange,
      });
      continue;
    }

    const coinPaprikaCtx = await resolveCoinPaprikaMarketContextForPair(env, pairName, { bypassCache });
    if (coinPaprikaCtx && coinPaprikaCtx.spotUsd > 0) {
      marketData.push({
        pair: pairName,
        priceUsd: coinPaprikaCtx.spotUsd,
        priceChange: coinPaprikaCtx.priceChange,
      });
      continue;
    }

    const demoCtx = resolveDemoMarketContextForPair(pairName);
    if (demoCtx && demoCtx.spotUsd > 0) {
      marketData.push({
        pair: pairName,
        priceUsd: demoCtx.spotUsd,
        priceChange: demoCtx.priceChange,
      });
    }
  }

  const memory =
    (await ctx.storage.get<ManagerMemory>('memory')) ?? {
      hypotheses: [],
      parameter_history: [],
      market_regime: null,
      last_evaluation_at: '',
    };

  const ownerAddr = managerRow.ownerAddress?.toLowerCase();
  const [ownerUser] = ownerAddr
    ? await db.select({ id: users.id, openRouterKey: users.openRouterKey }).from(users).where(eq(users.walletAddress, ownerAddr))
    : [];
  const hasUserOpenRouterKey = !!ownerUser?.openRouterKey;

  const prompt = buildManagerPrompt({
    agents: agentSnapshots,
    marketData,
    memory,
    managerConfig: config,
    managerPersonaMd: managerRow.personaMd,
    hasUserOpenRouterKey,
  });

  console.log('[manager-loop] === FULL PROMPT SENT TO MANAGER LLM ===');
  console.log('[manager-loop] Manager ID:', managerId);
  console.log('[manager-loop] Model:', config.llmModel);
  console.log('[manager-loop] Prompt length (chars):', prompt.length);
  console.log('[manager-loop] personaMd from DB:', managerRow.personaMd ?? '(none)');
  console.log('[manager-loop] --- PROMPT ---');
  console.log(prompt);
  console.log('[manager-loop] === END PROMPT ===');

  let rawResponse = '';
  let usage: { inputTokens?: number; outputTokens?: number } = {};
  if (!env.OPENROUTER_API_KEY) {
    console.warn(`[manager-loop] ${managerId}: OPENROUTER_API_KEY not set — holding`);
    rawResponse = JSON.stringify([{ action: 'hold', reasoning: 'No API key configured' }]);
  } else {
    try {
      let orApiKey = env.OPENROUTER_API_KEY;
      if (ownerAddr) {
        if (ownerUser?.openRouterKey) {
          const resolved = await resolveStoredOpenRouterKey({
            storedKey: ownerUser.openRouterKey,
            serverKey: env.OPENROUTER_API_KEY,
            encryptionSecret: env.KEY_ENCRYPTION_SECRET,
            logPrefix: '[manager-loop]',
            persistEncrypted: async (encryptedKey) => {
              await db
                .update(users)
                .set({ openRouterKey: encryptedKey, updatedAt: nowIso() })
                .where(eq(users.id, ownerUser.id));
            },
          });
          orApiKey = resolved.apiKey;
        }
      }
      const openrouter = createOpenRouter({ apiKey: orApiKey });
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Manager LLM timed out after ${MANAGER_LLM_TIMEOUT_MS / 1000}s`)), MANAGER_LLM_TIMEOUT_MS),
      );
      const result = await Promise.race([
        generateText({
          model: openrouter(config.llmModel),
          messages: [{ role: 'user', content: prompt }],
          temperature: config.temperature,
          maxOutputTokens: 2048,
        }),
        timeoutPromise,
      ]);
      rawResponse = result.text;
      usage = (result as any).usage ?? {};
      console.log('[manager-loop] === RAW LLM RESPONSE ===');
      console.log(rawResponse);
      console.log('[manager-loop] === END RESPONSE ===');
    } catch (err) {
      console.error(`[manager-loop] ${managerId}: LLM error:`, err);
      rawResponse = JSON.stringify([{ action: 'hold', reasoning: `LLM error: ${String(err)}` }]);
    }
  }

  const decisions = parseManagerDecisions(rawResponse);
  if (decisions.length === 0) {
    const preview = rawResponse.slice(0, 500);
    console.warn(`[manager-loop] ${managerId}: No valid decisions parsed. Raw response (first 500 chars): ${preview}`);
    decisions.push({
      action: 'hold',
      reasoning: preview || 'Holding this cycle (no structured decisions returned by model).',
    });
  }

  for (const decision of decisions) {
    const actionResult = await executeManagerAction(
      decision,
      db,
      env,
      managerId,
      managerRow.ownerAddress,
      hasUserOpenRouterKey,
    );
    const result = {
      ...actionResult,
      llmPromptText: prompt,
      llmRawResponse: rawResponse,
    };
    await db.insert(agentManagerLogs).values({
      id: generateId('mlog'),
      managerId,
      action: decision.action,
      reasoning: decision.reasoning,
      result: JSON.stringify(result),
      llmPromptTokens: usage.inputTokens ?? null,
      llmCompletionTokens: usage.outputTokens ?? null,
      createdAt: nowIso(),
    });
    console.log(`[manager-loop] ${managerId}: ${decision.action} → ${JSON.stringify(result)}`);
  }

  const updatedMemory: ManagerMemory = { ...memory, last_evaluation_at: nowIso() };
  await ctx.storage.put('memory', updatedMemory);

  console.log(`[manager-loop] ${managerId}: Cycle complete. ${decisions.length} decisions.`);
}
