import type { ManagerBehaviorConfig } from '../validation.js';

export interface ManagerProfile {
  id: string;
  name: string;
  description: string;
  emoji: string;
  category: 'preset' | 'custom';
  behavior: ManagerBehaviorConfig;
}

export const MANAGER_PROFILES: ManagerProfile[] = [
  {
    id: 'venture_mode',
    name: 'Venture Mode',
    emoji: '🚀',
    category: 'preset',
    description: 'Aggressive creation, high tolerance for losses, diversified portfolio.',
    behavior: {
      managementStyle: 'hands_off',
      riskTolerance: 'aggressive',
      diversificationPreference: 'diversified',
      performancePatience: 80,
      creationAggressiveness: 85,
      rebalanceFrequency: 'rarely',
      philosophyBias: 'trend_following',
    },
  },
  {
    id: 'risk_officer',
    name: 'Risk Officer',
    emoji: '🛡️',
    category: 'preset',
    description: 'Conservative, quick to kill underperforming agents, balanced portfolio.',
    behavior: {
      managementStyle: 'micromanager',
      riskTolerance: 'conservative',
      diversificationPreference: 'balanced',
      performancePatience: 20,
      creationAggressiveness: 25,
      rebalanceFrequency: 'often',
      philosophyBias: 'mean_reversion',
    },
  },
  {
    id: 'passive_index',
    name: 'Passive Index',
    emoji: '📊',
    category: 'preset',
    description: 'Hands off, diversified, rarely rebalances. Set and forget.',
    behavior: {
      managementStyle: 'hands_off',
      riskTolerance: 'moderate',
      diversificationPreference: 'diversified',
      performancePatience: 90,
      creationAggressiveness: 20,
      rebalanceFrequency: 'rarely',
      philosophyBias: 'mixed',
    },
  },
  {
    id: 'active_hedge',
    name: 'Active Hedge',
    emoji: '⚖️',
    category: 'preset',
    description: 'Micromanager, frequent rebalancing, mixed philosophy for risk-adjusted returns.',
    behavior: {
      managementStyle: 'micromanager',
      riskTolerance: 'moderate',
      diversificationPreference: 'balanced',
      performancePatience: 40,
      creationAggressiveness: 60,
      rebalanceFrequency: 'often',
      philosophyBias: 'mixed',
    },
  },
];

export function getManagerProfile(id: string): ManagerProfile | undefined {
  return MANAGER_PROFILES.find((p) => p.id === id);
}

export const DEFAULT_MANAGER_PROFILE_ID = 'passive_index';
