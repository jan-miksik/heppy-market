import { AgentBehaviorConfigSchema } from './validation.js';
import type { AgentBehaviorConfig } from './validation.js';

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

/** Build the constraints section to inject into prompts */
export function buildConstraintsSection(config: {
  pairs: string[];
  maxPositionSizePct: number;
  maxOpenPositions: number;
  stopLossPct: number;
  takeProfitPct: number;
}): string {
  return `## Constraints
Allowed pairs: ${config.pairs.join(', ')}
Max position size: ${config.maxPositionSizePct}% of balance
Max open positions: ${config.maxOpenPositions}
Stop loss: ${config.stopLossPct}%
Take profit: ${config.takeProfitPct}%`;
}
