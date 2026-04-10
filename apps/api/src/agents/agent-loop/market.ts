import { drizzle } from 'drizzle-orm/d1';
import { desc, eq } from 'drizzle-orm';
import type { Env } from '../../types/env.js';
import { agentDecisions } from '../../db/schema.js';
import { createDexDataService } from '../../services/dex-data.js';
import { createGeckoTerminalService } from '../../services/gecko-terminal.js';
import { createLogger } from '../../lib/logger.js';
import type { MarketDataItem, RecentDecision } from './types.js';
import { fetchOnePair } from './market-fetch.js';

export async function fetchAgentMarketContext(params: {
  agentId: string;
  env: Env;
  ctx: DurableObjectState;
  db: ReturnType<typeof drizzle>;
  pairsToFetch: string[];
  log: ReturnType<typeof createLogger>;
  bypassCache?: boolean;
}): Promise<{ marketData: MarketDataItem[]; recentDecisions: RecentDecision[] }> {
  const { agentId, env, ctx, db, pairsToFetch, log, bypassCache = false } = params;
  const geckoSvc = createGeckoTerminalService(env.CACHE, { bypassCache });
  const dexSvc = createDexDataService(env.CACHE, { bypassCache });

  const cachedRecentDecisions = await ctx.storage.get<RecentDecision[]>('recentDecisions');

  let pairResults: PromiseSettledResult<PromiseSettledResult<Awaited<ReturnType<typeof fetchOnePair>>>[]>;
  let recentDecisions: RecentDecision[];

  if (cachedRecentDecisions !== undefined) {
    recentDecisions = cachedRecentDecisions;
    pairResults = await Promise.allSettled(
      pairsToFetch.map((pairName) => fetchOnePair({ env, pairName, agentId, geckoSvc, dexSvc, log })),
    )
      .then((r) => ({ status: 'fulfilled' as const, value: r }))
      .catch((e) => ({ status: 'rejected' as const, reason: e }));
  } else {
    log.info('recent_decisions_cache_miss', { agentId });
    const [pairResultsRaw, dbDecisions] = await Promise.allSettled([
      Promise.allSettled(pairsToFetch.map((pairName) => fetchOnePair({ env, pairName, agentId, geckoSvc, dexSvc, log }))),
      db
        .select({
          decision: agentDecisions.decision,
          confidence: agentDecisions.confidence,
          createdAt: agentDecisions.createdAt,
        })
        .from(agentDecisions)
        .where(eq(agentDecisions.agentId, agentId))
        .orderBy(desc(agentDecisions.createdAt))
        .limit(10),
    ]);
    pairResults = pairResultsRaw;
    recentDecisions = dbDecisions.status === 'fulfilled' ? dbDecisions.value : [];
    if (dbDecisions.status === 'fulfilled') {
      try {
        await ctx.storage.put('recentDecisions', dbDecisions.value);
      } catch {
        // non-fatal
      }
    }
  }

  const marketData =
    pairResults.status === 'fulfilled'
      ? pairResults.value
          .filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof fetchOnePair>>> => r.status === 'fulfilled')
          .map((r) => r.value)
          .filter((v): v is NonNullable<typeof v> => v !== null)
      : [];

  return { marketData, recentDecisions };
}
