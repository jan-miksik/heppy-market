/**
 * System prompts for trading agents and managers.
 */
import { AgentBehaviorConfigSchema } from '@dex-agents/shared';
import type { AgentBehaviorConfig } from '@dex-agents/shared';

/**
 * Base prompt shared by all agents and managers.
 * Covers only universal invariants — hard constraints that apply regardless of
 * persona, behavior profile, or any other setting.
 * Everything else (risk appetite, trading style, confidence thresholds, how much
 * autonomy to exercise) must come from the agent's persona and behavior profile.
 */
export const BASE_AGENT_PROMPT = `You are a crypto trading agent operating on Base chain DEXes.

Analyze the provided market data, portfolio state, and recent decision history, then make a trading decision.

Hard constraints (always enforced, cannot be overridden by persona or behavior):
- Only trade pairs explicitly listed in your allowed list
- Always include a confidence value (0.0–1.0) that reflects your actual conviction

Your persona and behavior profile define everything else: your risk appetite, trading style, confidence thresholds, and how much autonomy you exercise. Follow those.`;

/** Build a complete analysis prompt for the LLM */
export function buildAnalysisPrompt(params: {
  portfolioState: {
    balance: number;
    openPositions: number;
    dailyPnlPct: number;
    totalPnlPct: number;
  };
  openPositions: Array<{
    pair: string;
    side: 'buy' | 'sell';
    entryPrice: number;
    amountUsd: number;
    unrealizedPct: number;
    currentPrice: number;
    openedAt: string;
    slPct: number;
    tpPct: number;
  }>;
  marketData: {
    pair: string;
    priceUsd: number;
    priceChange: Record<string, number | undefined>;
    volume24h?: number;
    liquidity?: number;
    indicatorText: string;
  }[];
  lastDecisions: Array<{
    decision: string;
    confidence: number;
    createdAt: string;
  }>;
  config: {
    pairs: string[];
    maxPositionSizePct: number;
    maxOpenPositions: number;
    stopLossPct: number;
    takeProfitPct: number;
  };
  autonomyLevel: 'full' | 'guided' | 'strict';
  behavior?: Partial<AgentBehaviorConfig>;
  personaMd?: string | null;
}): string {
  const { portfolioState, openPositions, marketData, lastDecisions, config, autonomyLevel, behavior, personaMd } = params;

  const maxPerTrade = (portfolioState.balance * config.maxPositionSizePct) / 100;
  const fmtPrice = (p: number) => p < 0.01 ? p.toFixed(6) : p.toFixed(2);

  const autonomyDesc: Record<string, string> = {
    strict: 'Strict — follow configured rules exactly, no discretion',
    guided: 'Guided — operate within configured bounds, persona guides style and judgment',
    full:   'Full — use complete discretion; persona and your own judgment can override defaults',
  };

  const selfModInstructions = autonomyLevel === 'strict' ? '' :
    autonomyLevel === 'guided'
      ? `\n## Self-Modification (optional)\nYou MAY suggest soft changes to your own setup for the next cycle. Include a "selfModification" key in your JSON response with: reason (string), changes.personaMd (updated persona markdown, optional), changes.behavior (object with any AgentBehaviorConfig keys, optional). You CANNOT modify hard trading parameters (SL, TP, position sizes).`
      : `\n## Self-Modification (optional)\nYou MAY suggest changes to your own setup for the next cycle. Include a "selfModification" key in your JSON response with: reason (string), changes.personaMd (updated persona markdown, optional), changes.behavior (object with any AgentBehaviorConfig keys, optional), changes.config (object with any of: stopLossPct, takeProfitPct, maxPositionSizePct — optional).`;

  const openPositionsSection = openPositions.length > 0
    ? `\n## Open Positions\n${openPositions.map((p) => {
        const slPrice = p.side === 'buy'
          ? p.entryPrice * (1 - p.slPct / 100)
          : p.entryPrice * (1 + p.slPct / 100);
        const tpPrice = p.side === 'buy'
          ? p.entryPrice * (1 + p.tpPct / 100)
          : p.entryPrice * (1 - p.tpPct / 100);
        const pnlSign = p.unrealizedPct >= 0 ? '+' : '';
        const hoursOpen = Math.round((Date.now() - new Date(p.openedAt).getTime()) / 3_600_000);
        return `- ${p.pair} ${p.side.toUpperCase()} · entry $${fmtPrice(p.entryPrice)} → now $${fmtPrice(p.currentPrice)} · unrealized ${pnlSign}${p.unrealizedPct.toFixed(2)}% · $${p.amountUsd.toFixed(0)} · ${hoursOpen}h open\n  SL at $${fmtPrice(slPrice)} | TP at $${fmtPrice(tpPrice)}`;
      }).join('\n')}\n`
    : '';

  return `## Portfolio State
Balance: $${portfolioState.balance.toFixed(2)} USDC
Open positions: ${portfolioState.openPositions} of ${config.maxOpenPositions} max
Max per trade: ${config.maxPositionSizePct}% ($${maxPerTrade.toFixed(0)})
Daily P&L: ${portfolioState.dailyPnlPct >= 0 ? '+' : ''}${portfolioState.dailyPnlPct.toFixed(2)}%
Total P&L: ${portfolioState.totalPnlPct >= 0 ? '+' : ''}${portfolioState.totalPnlPct.toFixed(2)}%
${openPositionsSection}
## Market Data
${marketData
  .map(
    (m) => `### ${m.pair}
Price: $${fmtPrice(m.priceUsd)}
24h change: ${m.priceChange.h24 !== undefined ? `${m.priceChange.h24 >= 0 ? '+' : ''}${m.priceChange.h24.toFixed(2)}%` : 'N/A'}
1h change: ${m.priceChange.h1 !== undefined ? `${m.priceChange.h1 >= 0 ? '+' : ''}${m.priceChange.h1.toFixed(2)}%` : 'N/A'}
Volume 24h: ${m.volume24h !== undefined ? `$${(m.volume24h / 1_000).toFixed(1)}K` : 'N/A'}
Liquidity: ${m.liquidity !== undefined ? `$${(m.liquidity / 1_000_000).toFixed(2)}M` : 'N/A'}
${m.indicatorText}`
  )
  .join('\n\n')}

## Recent Decisions (last ${lastDecisions.length})
${lastDecisions
  .slice(-5)
  .map((d) => `- ${d.createdAt.slice(0, 16)}: ${d.decision} (confidence: ${d.confidence.toFixed(2)})`)
  .join('\n') || 'No recent decisions'}

## Constraints
Autonomy: ${autonomyDesc[autonomyLevel] ?? autonomyLevel}
Allowed pairs: ${config.pairs.join(', ')}
Max position size: ${config.maxPositionSizePct}% of balance
Max open positions: ${config.maxOpenPositions}
Stop loss: ${config.stopLossPct}%
Take profit: ${config.takeProfitPct}%
${selfModInstructions}
${behavior ? '\n\n' + buildBehaviorSection(behavior) : ''}${personaMd ? '\n\n## Your Persona\n' + personaMd : ''}

Based on the above data, what is your trading decision?`;
}

/** Build a human-readable behavior section to inject into prompts */
export function buildBehaviorSection(behavior: Partial<AgentBehaviorConfig>): string {
  const b = AgentBehaviorConfigSchema.parse({ ...behavior });
  return `## Your Behavior Profile
- Risk Appetite: ${b.riskAppetite} | FOMO Prone: ${b.fomoProne}/100 | Panic Sell Threshold: ${b.panicSellThreshold}/100
- Analysis Depth: ${b.analysisDepth} | Decision Speed: ${b.decisionSpeed} | Confidence Threshold: ${b.confidenceThreshold}%
- Trading Style: ${b.style} | Entry Preference: ${b.entryPreference} | Exit Strategy: ${b.exitStrategy}
- Market Bias: ${b.defaultBias} | Contrarian: ${b.contrarian}/100 | Adaptability: ${b.adaptability}/100
- Average Down on losses: ${b.averageDown ? 'Yes' : 'No'} | Overthinker: ${b.overthinker ? 'Yes' : 'No'}
- Preferred Conditions: ${b.preferredConditions} | Memory Weight: ${b.memoryWeight}

Precedence: behavior config (parameters above) > persona text > everything else.`;
}
