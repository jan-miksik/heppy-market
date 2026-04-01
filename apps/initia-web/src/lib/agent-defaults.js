import { DEFAULT_FREE_AGENT_MODEL } from '@something-in-loop/shared'

export const AVAILABLE_PAIRS = ['WETH/USDC', 'cbBTC/USDC', 'AERO/WETH']

export const DEFAULT_BEHAVIOR = {
  riskAppetite: 'moderate',
  fomoProne: 30,
  panicSellThreshold: 50,
  contrarian: 20,
  analysisDepth: 'balanced',
  decisionSpeed: 'measured',
  confidenceThreshold: 60,
  overthinker: false,
  style: 'swing',
  preferredConditions: 'any',
  entryPreference: 'momentum',
  exitStrategy: 'signal_based',
  averageDown: false,
  verbosity: 'normal',
  personality: 'professional',
  emotionalAwareness: false,
  defaultBias: 'neutral',
  adaptability: 50,
  memoryWeight: 'medium',
}

export function createDefaultAgentForm() {
  return {
    name: '',
    pairs: ['WETH/USDC'],
    paperBalance: 1000,
    strategies: ['combined'],
    analysisInterval: '1h',
    maxPositionSizePct: 2,
    stopLossPct: 2,
    takeProfitPct: 3,
    maxOpenPositions: 3,
    llmModel: DEFAULT_FREE_AGENT_MODEL,
    allowFallback: false,
    temperature: 0.7,
    behavior: { ...DEFAULT_BEHAVIOR },
    profileId: undefined,
    personaMd: '',
    behaviorMd: '',
    roleMd: '',
  }
}
