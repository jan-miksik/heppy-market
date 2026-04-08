/**
 * System prompts for trading agents and managers.
 */
import type { AgentBehaviorConfig } from '@something-in-loop/shared';
import { BASE_AGENT_PROMPT, AGENT_ROLE_SECTION, buildBehaviorSection, buildConstraintsSection } from '@something-in-loop/shared';

export { BASE_AGENT_PROMPT, AGENT_ROLE_SECTION };

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
    dailyIndicatorText?: string;
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
  behavior?: Partial<AgentBehaviorConfig>;
  personaMd?: string | null;
  behaviorMd?: string | null;
  roleMd?: string | null;
}): string {
  const { portfolioState, openPositions, marketData, lastDecisions, config, behavior, personaMd, behaviorMd, roleMd } = params;

  const maxPerTrade = (portfolioState.balance * config.maxPositionSizePct) / 100;
  const fmtPrice = (p: number) => p < 0.01 ? p.toFixed(6) : p.toFixed(2);

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
5m change: ${m.priceChange.m5 !== undefined ? `${m.priceChange.m5 >= 0 ? '+' : ''}${m.priceChange.m5.toFixed(2)}%` : 'N/A'}
1h change: ${m.priceChange.h1 !== undefined ? `${m.priceChange.h1 >= 0 ? '+' : ''}${m.priceChange.h1.toFixed(2)}%` : 'N/A'}
6h change: ${m.priceChange.h6 !== undefined ? `${m.priceChange.h6 >= 0 ? '+' : ''}${m.priceChange.h6.toFixed(2)}%` : 'N/A'}
24h change: ${m.priceChange.h24 !== undefined ? `${m.priceChange.h24 >= 0 ? '+' : ''}${m.priceChange.h24.toFixed(2)}%` : 'N/A'}
Volume 24h: ${m.volume24h !== undefined ? `$${(m.volume24h / 1_000).toFixed(1)}K` : 'N/A'}
Liquidity: ${m.liquidity !== undefined ? `$${(m.liquidity / 1_000_000).toFixed(2)}M` : 'N/A'}
Short-term (48h hourly):
${m.indicatorText}${m.dailyIndicatorText ? `\nDaily trend (30d):\n${m.dailyIndicatorText}` : ''}`
  )
  .join('\n\n')}

## Recent Decisions (last ${lastDecisions.length})
${lastDecisions
  .map((d) => `- ${d.createdAt.slice(0, 16)}: ${d.decision} (confidence: ${d.confidence.toFixed(2)})`)
  .join('\n') || 'No recent decisions'}

${roleMd || AGENT_ROLE_SECTION}

${behaviorMd ? behaviorMd + '\n\n' : (behavior ? buildBehaviorSection(behavior) + '\n\n' : '')}${personaMd ? '## Your Persona\n' + personaMd + '\n\n' : ''}## Constraints
Allowed pairs: ${config.pairs.join(', ')}
Max position size: ${config.maxPositionSizePct}% of balance
Max open positions: ${config.maxOpenPositions}
Stop loss: ${config.stopLossPct}%
Take profit: ${config.takeProfitPct}%

Based on the above data, what is your trading decision?`;
}

export { buildBehaviorSection, buildConstraintsSection };

/**
 * Build a perp-only analysis prompt for the LLM.
 * Legal actions: OPEN_LONG, OPEN_SHORT, CLOSE_LONG, CLOSE_SHORT, HOLD.
 * The LLM must NOT produce calldata, token addresses, selectors, or deadlines.
 */
export function buildPerpAnalysisPrompt(params: {
  portfolioState: {
    balance: number;
    openPositions: number;
    dailyPnlPct: number;
    totalPnlPct: number;
  };
  currentPositionState: 'FLAT' | 'LONG' | 'SHORT';
  marketData: {
    pair: string;
    priceUsd: number;
    priceChange: Record<string, number | undefined>;
    volume24h?: number;
    liquidity?: number;
    indicatorText: string;
    dailyIndicatorText?: string;
  }[];
  lastDecisions: Array<{
    decision: string;
    confidence: number;
    createdAt: string;
  }>;
  config: {
    pairs: string[];
    maxPositionSizePct: number;
  };
  behavior?: Partial<AgentBehaviorConfig>;
  personaMd?: string | null;
  behaviorMd?: string | null;
  roleMd?: string | null;
}): string {
  const { portfolioState, currentPositionState, marketData, lastDecisions, config, behavior, personaMd, behaviorMd, roleMd } = params;

  const maxPerTrade = (portfolioState.balance * config.maxPositionSizePct) / 100;
  const fmtPrice = (p: number) => (p < 0.01 ? p.toFixed(6) : p.toFixed(2));

  const legalActions =
    currentPositionState === 'FLAT'
      ? 'OPEN_LONG, OPEN_SHORT, or HOLD'
      : currentPositionState === 'LONG'
      ? 'CLOSE_LONG or HOLD'
      : 'CLOSE_SHORT or HOLD';

  return `## Portfolio State (Perp Trading)
Balance: $${portfolioState.balance.toFixed(2)} USDC
Open positions: ${portfolioState.openPositions}
Current position state: ${currentPositionState}
Max per trade: ${config.maxPositionSizePct}% ($${maxPerTrade.toFixed(0)})
Daily P&L: ${portfolioState.dailyPnlPct >= 0 ? '+' : ''}${portfolioState.dailyPnlPct.toFixed(2)}%
Total P&L: ${portfolioState.totalPnlPct >= 0 ? '+' : ''}${portfolioState.totalPnlPct.toFixed(2)}%

## Market Data
${marketData
  .map(
    (m) => `### ${m.pair}
Price: $${fmtPrice(m.priceUsd)}
5m change: ${m.priceChange.m5 !== undefined ? `${m.priceChange.m5 >= 0 ? '+' : ''}${m.priceChange.m5.toFixed(2)}%` : 'N/A'}
1h change: ${m.priceChange.h1 !== undefined ? `${m.priceChange.h1 >= 0 ? '+' : ''}${m.priceChange.h1.toFixed(2)}%` : 'N/A'}
6h change: ${m.priceChange.h6 !== undefined ? `${m.priceChange.h6 >= 0 ? '+' : ''}${m.priceChange.h6.toFixed(2)}%` : 'N/A'}
24h change: ${m.priceChange.h24 !== undefined ? `${m.priceChange.h24 >= 0 ? '+' : ''}${m.priceChange.h24.toFixed(2)}%` : 'N/A'}
Volume 24h: ${m.volume24h !== undefined ? `$${(m.volume24h / 1_000).toFixed(1)}K` : 'N/A'}
Liquidity: ${m.liquidity !== undefined ? `$${(m.liquidity / 1_000_000).toFixed(2)}M` : 'N/A'}
Short-term (48h hourly):
${m.indicatorText}${m.dailyIndicatorText ? `\nDaily trend (30d):\n${m.dailyIndicatorText}` : ''}`
  )
  .join('\n\n')}

## Recent Decisions (last ${lastDecisions.length})
${lastDecisions
  .map((d) => `- ${d.createdAt.slice(0, 16)}: ${d.decision} (confidence: ${d.confidence.toFixed(2)})`)
  .join('\n') || 'No recent decisions'}

${roleMd || AGENT_ROLE_SECTION}

${behaviorMd ? behaviorMd + '\n\n' : behavior ? buildBehaviorSection(behavior) + '\n\n' : ''}${personaMd ? '## Your Persona\n' + personaMd + '\n\n' : ''}## Perpetual Trading Rules
- You are operating in PERPETUAL TRADING mode (long and short supported, leverage=1x for now).
- Current state: **${currentPositionState}**
- Legal actions right now: **${legalActions}**
- Transition rules:
  - FLAT + OPEN_LONG → LONG (enter a long position)
  - FLAT + OPEN_SHORT → SHORT (enter a short position)
  - LONG + CLOSE_LONG → FLAT (close your long)
  - SHORT + CLOSE_SHORT → FLAT (close your short)
  - Any state + HOLD → unchanged (wait)
  - LONG + OPEN_LONG / OPEN_SHORT is ILLEGAL
  - SHORT + OPEN_SHORT / OPEN_LONG is ILLEGAL
  - FLAT + CLOSE_LONG / CLOSE_SHORT is ILLEGAL
- Set sizePct (0–100) only for OPEN actions; use 0 for CLOSE and HOLD.
- Set maxSlippageBps to your acceptable slippage in basis points (e.g. 50 = 0.5%).
- Do NOT produce calldata, token addresses, function selectors, deadlines, or wei amounts.

## Constraints
Allowed pairs: ${config.pairs.join(', ')}
Max position size: ${config.maxPositionSizePct}% of balance

Based on the above data, what is your perpetual trading decision?`;
}
