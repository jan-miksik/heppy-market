/**
 * System prompts for each autonomy level.
 * These define the LLM's role and constraints when making trading decisions.
 */

export const FULL_AUTONOMY_PROMPT = `You are an autonomous crypto trading agent operating on Base chain DEXes.
You have full authority to:
- Choose which pairs to analyze from your allowed list
- Select trading strategies dynamically
- Adjust position sizes within bounds
- Suggest configuration tweaks for better performance

Analyze the provided market data, portfolio state, and recent decision history.
Make a trading decision and explain your reasoning clearly.

If you see a pattern that your current strategy config doesn't cover, include
a "config_suggestion" in your reasoning field.

Rules:
- Only trade pairs in your allowed list
- Never exceed max position size percentage
- Always include confidence (0.0-1.0) reflecting conviction
- If uncertain, hold is always a valid choice`;

export const GUIDED_PROMPT = `You are a guided crypto trading agent on Base chain.
You analyze markets and make recommendations within defined bounds.

You MUST stay within these constraints:
- Only trade pairs from the provided allowed list
- Position size must be within the configured min/max range
- Only use the configured strategies

Analyze the market data and current portfolio.
Recommend a trade action. Explain your reasoning clearly.
If the best action is to hold, say so with confidence.

Be conservative — a missed trade is better than a bad trade.
Confidence below 0.6 means hold.`;

export const STRICT_RULES_PROMPT = `You are a rule-following trading analysis agent.
Your ONLY job is to evaluate technical indicators and report signals.
You do NOT decide trades — the system executes based on rules.

Evaluate the provided indicator values against the active strategy rules.
Report which rules are triggered and with what confidence.

Format your response as:
- action: the triggered action (buy/sell/hold)
- confidence: 0.0-1.0 based on indicator strength
- reasoning: clear explanation of which indicators triggered

Be precise and systematic. Do not add opinions or speculation.`;

/** Build a complete analysis prompt for the LLM */
export function buildAnalysisPrompt(params: {
  systemPrompt: string;
  portfolioState: {
    balance: number;
    openPositions: number;
    dailyPnlPct: number;
    totalPnlPct: number;
  };
  marketData: {
    pair: string;
    priceUsd: number;
    priceChange: Record<string, number | undefined>;
    volume24h?: number;
    liquidity?: number;
    indicators?: Record<string, unknown>;
  }[];
  lastDecisions: Array<{
    decision: string;
    confidence: number;
    createdAt: string;
  }>;
  config: {
    pairs: string[];
    maxPositionSizePct: number;
    strategies: string[];
  };
}): string {
  const { portfolioState, marketData, lastDecisions, config } = params;

  return `## Portfolio State
Balance: $${portfolioState.balance.toFixed(2)} USDC
Open positions: ${portfolioState.openPositions}/${config.maxPositionSizePct}% max
Daily P&L: ${portfolioState.dailyPnlPct >= 0 ? '+' : ''}${portfolioState.dailyPnlPct.toFixed(2)}%
Total P&L: ${portfolioState.totalPnlPct >= 0 ? '+' : ''}${portfolioState.totalPnlPct.toFixed(2)}%

## Market Data
${marketData
  .map(
    (m) => `### ${m.pair}
Price: $${m.priceUsd.toFixed(6)}
24h change: ${m.priceChange.h24 !== undefined ? `${m.priceChange.h24 >= 0 ? '+' : ''}${m.priceChange.h24.toFixed(2)}%` : 'N/A'}
1h change: ${m.priceChange.h1 !== undefined ? `${m.priceChange.h1 >= 0 ? '+' : ''}${m.priceChange.h1.toFixed(2)}%` : 'N/A'}
Volume 24h: ${m.volume24h !== undefined ? `$${(m.volume24h / 1_000).toFixed(1)}K` : 'N/A'}
Liquidity: ${m.liquidity !== undefined ? `$${(m.liquidity / 1_000_000).toFixed(2)}M` : 'N/A'}
${
  m.indicators
    ? `Indicators: ${JSON.stringify(m.indicators, null, 2)}`
    : ''
}`
  )
  .join('\n\n')}

## Recent Decisions (last ${lastDecisions.length})
${lastDecisions
  .slice(-5)
  .map((d) => `- ${d.createdAt.slice(0, 16)}: ${d.decision} (confidence: ${d.confidence.toFixed(2)})`)
  .join('\n') || 'No recent decisions'}

## Constraints
Allowed pairs: ${config.pairs.join(', ')}
Max position size: ${config.maxPositionSizePct}% of balance
Active strategies: ${config.strategies.join(', ')}

Based on the above data, what is your trading decision?`;
}
