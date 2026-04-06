import { desc, eq } from 'drizzle-orm';
import { DEFAULT_AGENT_PROFILE_ID, UpdatePersonaSchema, getAgentPersonaTemplate } from '@something-in-loop/shared';
import { BASE_AGENT_PROMPT, buildAnalysisPrompt } from '../../agents/prompts.js';
import { resolveAgentPersonaMd } from '../../agents/resolve-agent-persona.js';
import { agentDecisions, agents, trades } from '../../db/schema.js';
import { nowIso } from '../../lib/utils.js';
import { validateBody } from '../../lib/validation.js';
import { buildJsonSchemaInstruction } from '../../services/llm-router.js';
import { parseJsonRequired } from '../../lib/json.js';
import { parseAgentConfig, withOwnedAgent } from './shared.js';
import type { AgentsRoute } from './shared.js';

export function registerAgentPersonaRoutes(agentsRoute: AgentsRoute): void {
  /** GET /api/agents/:id/persona */
  agentsRoute.get('/:id/persona', async (c) => {
    return withOwnedAgent(c, async ({ agent }) => (
      c.json({ personaMd: agent.personaMd ?? null, profileId: agent.profileId ?? null })
    ));
  });

  /** PUT /api/agents/:id/persona */
  agentsRoute.put('/:id/persona', async (c) => {
    const body = await validateBody(c, UpdatePersonaSchema);
    return withOwnedAgent(c, async ({ id, db }) => {
      await db.update(agents).set({ personaMd: body.personaMd, updatedAt: nowIso() }).where(eq(agents.id, id));
      return c.json({ ok: true, personaMd: body.personaMd });
    });
  });

  /** POST /api/agents/:id/persona/reset */
  agentsRoute.post('/:id/persona/reset', async (c) => {
    return withOwnedAgent(c, async ({ id, db, agent }) => {
      const config = parseAgentConfig(agent.config) as { profileId?: string };
      const profileId = config.profileId ?? agent.profileId ?? DEFAULT_AGENT_PROFILE_ID;
      const personaMd = getAgentPersonaTemplate(profileId, agent.name);
      await db.update(agents).set({ personaMd, updatedAt: nowIso() }).where(eq(agents.id, id));
      return c.json({ ok: true, personaMd });
    });
  });

  /** GET /api/agents/:id/prompt-preview — build the full prompt from last market snapshot */
  agentsRoute.get('/:id/prompt-preview', async (c) => {
    return withOwnedAgent(c, async ({ id, db, agent }) => {
      const config = parseAgentConfig(agent.config);

      const [lastDecision] = await db
        .select()
        .from(agentDecisions)
        .where(eq(agentDecisions.agentId, id))
        .orderBy(desc(agentDecisions.createdAt))
        .limit(1);

      const rawMarketData = lastDecision?.marketDataSnapshot
        ? parseJsonRequired<Array<{
            pair: string;
            priceUsd: number;
            priceChange: Record<string, number | undefined>;
            volume24h?: number;
            liquidity?: number;
            indicatorText: string;
          }>>(lastDecision.marketDataSnapshot)
        : [];

      const recentDecisions = await db
        .select({ decision: agentDecisions.decision, confidence: agentDecisions.confidence, createdAt: agentDecisions.createdAt })
        .from(agentDecisions)
        .where(eq(agentDecisions.agentId, id))
        .orderBy(desc(agentDecisions.createdAt))
        .limit(10);

      const allTrades = await db.select().from(trades).where(eq(trades.agentId, id));
      const openTrades = allTrades.filter((t) => t.status === 'open');
      const closedTrades = allTrades.filter((t) => t.status !== 'open');

      // Enrich open positions with current price + unrealized P&L using the latest market snapshot
      const openPositions = openTrades.map((t) => {
        const m = rawMarketData.find((entry) => entry.pair === t.pair);
        const currentPrice = m?.priceUsd && m.priceUsd > 0 ? m.priceUsd : t.entryPrice;
        const unrealizedPct =
          m && m.priceUsd > 0
            ? (t.side === 'buy'
                ? ((currentPrice - t.entryPrice) / t.entryPrice) * 100
                : ((t.entryPrice - currentPrice) / t.entryPrice) * 100)
            : 0;

        return {
          pair: t.pair,
          side: t.side as 'buy' | 'sell',
          entryPrice: t.entryPrice,
          amountUsd: t.amountUsd,
          unrealizedPct,
          currentPrice,
          openedAt: t.openedAt,
          slPct: (typeof config.stopLossPct === 'number' ? config.stopLossPct : undefined) ?? 5,
          tpPct: (typeof config.takeProfitPct === 'number' ? config.takeProfitPct : undefined) ?? 7,
        };
      });

      const paperBalance = (typeof config.paperBalance === 'number' ? config.paperBalance : undefined) ?? 10000;

      // Approximate portfolio P&L from trades + latest prices
      const realizedPnlUsd = closedTrades.reduce((sum, t) => sum + (t.pnlUsd ?? 0), 0);
      const unrealizedPnlUsd = openPositions.reduce((sum, p) => sum + ((p.unrealizedPct / 100) * p.amountUsd), 0);
      const totalPnlUsd = realizedPnlUsd + unrealizedPnlUsd;
      const totalPnlPct = paperBalance > 0 ? (totalPnlUsd / paperBalance) * 100 : 0;

      const systemPrompt = BASE_AGENT_PROMPT + buildJsonSchemaInstruction();
      const personaMd = resolveAgentPersonaMd({
        agentName: agent.name,
        agentPersonaMd: agent.personaMd,
        agentProfileId: agent.profileId,
        config,
      });
      const userPrompt = rawMarketData.length > 0
        ? buildAnalysisPrompt({
            portfolioState: {
              balance: paperBalance + totalPnlUsd,
              openPositions: openPositions.length,
              dailyPnlPct: 0,
              totalPnlPct,
            },
            openPositions,
            marketData: rawMarketData,
            lastDecisions: recentDecisions,
            config: {
              pairs: Array.isArray(config.pairs) ? (config.pairs as string[]) : [],
              maxPositionSizePct: (typeof config.maxPositionSizePct === 'number' ? config.maxPositionSizePct : undefined) ?? 5,
              maxOpenPositions: (typeof config.maxOpenPositions === 'number' ? config.maxOpenPositions : undefined) ?? 3,
              stopLossPct: (typeof config.stopLossPct === 'number' ? config.stopLossPct : undefined) ?? 5,
              takeProfitPct: (typeof config.takeProfitPct === 'number' ? config.takeProfitPct : undefined) ?? 7,
            },
            behavior: config.behavior as Record<string, unknown>,
            personaMd,
            behaviorMd: typeof config.behaviorMd === 'string' ? config.behaviorMd : null,
            roleMd: typeof config.roleMd === 'string' ? config.roleMd : null,
          })
        : '(No market data yet — run the agent at least once to populate the preview)';

      return c.json({
        systemPrompt,
        userPrompt,
        marketDataAt: lastDecision?.createdAt ?? null,
        hasMarketData: rawMarketData.length > 0,
      });
    });
  });
}
