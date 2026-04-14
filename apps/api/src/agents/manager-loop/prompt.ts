import type { ManagerConfig } from '@something-in-loop/shared';
import {
  AGENT_PROFILES,
  DEFAULT_FREE_AGENT_MODEL,
  SUPPORTED_BASE_PAIRS,
  getManagerAllowedAgentModelIds,
} from '@something-in-loop/shared';
import type { ManagedAgentSnapshot, ManagerMemory } from './types.js';

export type BuildManagerPromptParams = {
  agents: ManagedAgentSnapshot[];
  marketData: Array<{
    pair: string;
    priceUsd: number;
    priceChange: Record<string, number | undefined>;
    indicators?: Record<string, unknown>;
  }>;
  memory: ManagerMemory;
  managerConfig: ManagerConfig;
  managerPersonaMd?: string | null;
  hasUserOpenRouterKey?: boolean;
};

export function buildManagerPrompt(ctx: BuildManagerPromptParams): string {
  const { agents: managedAgents, marketData, memory, managerConfig, managerPersonaMd } = ctx;
  const hasUserOpenRouterKey = !!ctx.hasUserOpenRouterKey;
  const availableModels = getManagerAllowedAgentModelIds(hasUserOpenRouterKey);

  const agentSummaries = managedAgents
    .map(
      (a) =>
        `Agent: ${a.name} (id: ${a.id})\n` +
        `  Status: ${a.status} | Pairs: ${a.config.pairs.join(', ')} | Model: ${a.llmModel} temp=${a.config.temperature}\n` +
        `  PnL: ${a.performance.totalPnlPct.toFixed(2)}% | WinRate: ${(a.performance.winRate * 100).toFixed(1)}% | Trades: ${a.performance.totalTrades} | Sharpe: ${a.performance.sharpeRatio?.toFixed(2) ?? 'N/A'} | MaxDD: ${a.performance.maxDrawdown != null ? (a.performance.maxDrawdown * 100).toFixed(1) + '%' : 'N/A'}\n` +
        `  Balance: $${a.performance.balance.toFixed(2)}\n` +
        `  Recent trades: ${a.recentTrades.map((t) => `${t.side} ${t.pair} PnL=${t.pnlPct?.toFixed(2) ?? 'open'}%`).join(', ') || 'none'}`,
    )
    .join('\n\n');

  const marketSummary =
    marketData.length > 0
      ? marketData
        .map((m) => `${m.pair}: $${m.priceUsd} (1h: ${m.priceChange.h1 ?? 'N/A'}%, 24h: ${m.priceChange.h24 ?? 'N/A'}%)`)
        .join('\n')
      : 'No market data available';

  const memorySummary =
    memory.hypotheses.length > 0
      ? memory.hypotheses
        .map((h) => `- "${h.description}" (tested: ${h.tested_at}, outcome: ${h.outcome}, valid: ${h.still_valid})`)
        .join('\n')
      : 'No prior hypotheses.';

  const riskSummary = `MaxDrawdown: ${(managerConfig.riskParams.maxTotalDrawdown * 100).toFixed(0)}%, MaxAgents: ${managerConfig.riskParams.maxAgents}, MaxCorrelated: ${managerConfig.riskParams.maxCorrelatedPositions}`;

  const b = managerConfig.behavior;
  const behaviorSection = b
    ? `## Your Management Style
- Risk Tolerance: ${b.riskTolerance} | Management Style: ${b.managementStyle}
- Creation Aggressiveness: ${b.creationAggressiveness}/100 | Performance Patience: ${b.performancePatience}/100
- Diversification: ${b.diversificationPreference} | Rebalance Frequency: ${b.rebalanceFrequency}
- Philosophy: ${b.philosophyBias}`
    : '';

  const personaSection = managerPersonaMd ? `## Your Persona\n${managerPersonaMd}\n` : '';

  return `${personaSection}You are an Agent Manager overseeing a portfolio of paper trading agents on Base chain DEXes.
Managers are paper-only in this product: you may create and manage paper agents only, and you must never request live, onchain, or Initia-linked agents.

## Managed Agents (${managedAgents.length})
${agentSummaries || 'No agents yet.'}

## Current Market Conditions
${marketSummary}

## Memory & Hypotheses
${memorySummary}

## Risk Limits
${riskSummary}
${behaviorSection ? '\n' + behaviorSection : ''}
## Allowed Trading Pairs
When creating or modifying agents, you MUST choose pairs only from this allowlist:
${SUPPORTED_BASE_PAIRS.map((p: string) => `- "${p}"`).join('\n')}

## Allowed Agent Analysis Intervals
When creating or modifying agents, "analysisInterval" MUST be one of:
- "1h"
- "4h"
- "1d"

## Available LLM Models For Agents
${hasUserOpenRouterKey
      ? 'The user has OpenRouter connected, use any supported llmModel ID. More specific model setup belongs in the Edit context, if not specified use low-cost free models or paid models (up to $3 per 1M tokens). '
      : 'The user has no connected OpenRouter key, so you must use one of these free llmModel IDs when creating or modifying agents:'}
${availableModels.map((m) => `- "${m}"`).join('\n')}

If unsure, default to "${DEFAULT_FREE_AGENT_MODEL}".

## Available Agent Profiles
When creating agents, pick a profileId that naturally fits your management style and risk tolerance — or combine several across your fleet for diversity. You can also write a fully custom personaMd instead.
${AGENT_PROFILES.map((p) => `- "${p.id}" ${p.emoji} ${p.name}: ${p.description}`).join('\n')}

## Instructions
Evaluate each agent's performance and decide what actions to take this cycle.

Valid actions:
- "create_agent": spawn a new paper agent. Params: name, pairs, llmModel, temperature, analysisInterval (1h|4h|1d), strategies, paperBalance; optional: profileId (from the list above — sets the agent's persona), personaMd (custom markdown persona, overrides profileId), stopLossPct, takeProfitPct, maxPositionSizePct, maxOpenPositions, maxDailyLossPct, cooldownAfterLossMinutes. Never include live/onchain fields such as chain overrides, isPaper=false, Initia metadata, or wallet addresses.
- "start_agent": start a stopped or paused paper agent (provide agentId)
- "pause_agent": pause an underperforming paper agent (provide agentId)
- "modify_agent": change paper-agent parameters (provide agentId + params). Params can include: name, pairs, llmModel, temperature, analysisInterval (1h|4h|1d), strategies, paperBalance, stopLossPct, takeProfitPct, maxPositionSizePct, maxOpenPositions, personaMd (markdown), profileId, etc. Never include live/onchain fields or any non-paper transition.
- "terminate_agent": permanently stop a paper agent (provide agentId)
- "hold": no action needed (provide agentId, or omit for portfolio-level hold)

IMPORTANT: Respond with ONLY a valid JSON array — no markdown, no explanation.
Each element: { "action": "<action>", "agentId": "<id or omit>", "params": {<optional>}, "reasoning": "<why>" }
Output constraints:
- Keep each "reasoning" under 160 characters.
- Prefer "profileId" over "personaMd" to keep output short; only include "personaMd" if absolutely necessary, and keep it under 400 characters.
- Omit params that you want to keep at defaults.

Example:
[
  { "action": "hold", "agentId": "agent_001", "reasoning": "Strong performance, no changes needed" },
  { "action": "pause_agent", "agentId": "agent_002", "reasoning": "Drawdown exceeds 15%" }
]`;
}
