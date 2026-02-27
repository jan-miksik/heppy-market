# Agent & Manager Personality System Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add editable behavior profiles, structured personality settings, and per-agent persona markdown files to AI trading agents and managers, so users can control *how* agents think and trade.

**Architecture:** Behavior config is stored as a nested `behavior` key inside the existing `config` JSON blob (backward compatible). A new `persona_md` column on agents/managers stores free-form markdown injected into the LLM system prompt. Preset profiles live in a shared package; custom profiles are stored in a new `behavior_profiles` D1 table.

**Tech Stack:** TypeScript, Zod, Drizzle ORM, Cloudflare D1, Hono, Nuxt 4 / Vue 3

---

## Task 1: Shared Types & Zod Schemas

**Files:**
- Modify: `packages/shared/src/validation.ts`
- Modify: `packages/shared/src/types.ts`
- Modify: `packages/shared/src/index.ts`

**Step 1: Add `AgentBehaviorConfigSchema` to `packages/shared/src/validation.ts`**

Append to the end of `packages/shared/src/validation.ts`:

```typescript
// ─── Behavior Config ────────────────────────────────────────────────────────

export const AgentBehaviorConfigSchema = z.object({
  // Risk Personality
  riskAppetite: z.enum(['conservative', 'moderate', 'aggressive', 'degen']).default('moderate'),
  fomoProne: z.number().min(0).max(100).default(30),
  panicSellThreshold: z.number().min(0).max(100).default(50),
  contrarian: z.number().min(0).max(100).default(20),

  // Decision Style
  analysisDepth: z.enum(['quick', 'balanced', 'thorough']).default('balanced'),
  decisionSpeed: z.enum(['impulsive', 'measured', 'patient']).default('measured'),
  confidenceThreshold: z.number().min(0).max(100).default(60),
  overthinker: z.boolean().default(false),

  // Trading Philosophy
  style: z.enum(['scalper', 'swing', 'position', 'hybrid']).default('swing'),
  preferredConditions: z.enum(['trending', 'ranging', 'volatile', 'any']).default('any'),
  entryPreference: z.enum(['breakout', 'pullback', 'dip_buy', 'momentum']).default('momentum'),
  exitStrategy: z.enum(['tight_stops', 'trailing', 'time_based', 'signal_based']).default('signal_based'),
  averageDown: z.boolean().default(false),

  // Communication & Logging
  verbosity: z.enum(['minimal', 'normal', 'detailed', 'stream_of_consciousness']).default('normal'),
  personality: z.enum(['professional', 'casual', 'meme_lord', 'academic', 'custom']).default('professional'),
  emotionalAwareness: z.boolean().default(false),

  // Market Outlook
  defaultBias: z.enum(['bullish', 'bearish', 'neutral']).default('neutral'),
  adaptability: z.number().min(0).max(100).default(50),
  memoryWeight: z.enum(['short', 'medium', 'long']).default('medium'),
});

export type AgentBehaviorConfig = z.infer<typeof AgentBehaviorConfigSchema>;

export const ManagerBehaviorConfigSchema = z.object({
  managementStyle: z.enum(['hands_off', 'balanced', 'micromanager']).default('balanced'),
  riskTolerance: z.enum(['conservative', 'moderate', 'aggressive']).default('moderate'),
  diversificationPreference: z.enum(['concentrated', 'balanced', 'diversified']).default('balanced'),
  performancePatience: z.number().min(0).max(100).default(50),
  creationAggressiveness: z.number().min(0).max(100).default(50),
  rebalanceFrequency: z.enum(['rarely', 'sometimes', 'often']).default('sometimes'),
  philosophyBias: z.enum(['trend_following', 'mean_reversion', 'mixed']).default('mixed'),
});

export type ManagerBehaviorConfig = z.infer<typeof ManagerBehaviorConfigSchema>;

export const BehaviorProfileSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  emoji: z.string(),
  type: z.enum(['agent', 'manager']),
  category: z.enum(['preset', 'custom']),
  behaviorConfig: z.union([AgentBehaviorConfigSchema, ManagerBehaviorConfigSchema]),
  isPreset: z.boolean().default(false),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
});

export type BehaviorProfile = z.infer<typeof BehaviorProfileSchema>;

export const CreateBehaviorProfileSchema = z.object({
  name: z.string().min(1).max(50),
  emoji: z.string().default('🤖'),
  description: z.string().max(500).optional(),
  type: z.enum(['agent', 'manager']),
  behaviorConfig: z.union([AgentBehaviorConfigSchema, ManagerBehaviorConfigSchema]),
});

export const UpdatePersonaSchema = z.object({
  personaMd: z.string().max(4000),
});
```

**Step 2: Update `AgentConfigSchema` to include optional behavior**

In `packages/shared/src/validation.ts`, add `behavior` to `AgentConfigSchema` (add before the closing `})`):

```typescript
  // Behavior (optional — falls back to defaults / profile)
  behavior: AgentBehaviorConfigSchema.optional(),
  profileId: z.string().optional(),
```

And to `ManagerConfigSchema`:
```typescript
  behavior: ManagerBehaviorConfigSchema.optional(),
  profileId: z.string().optional(),
```

Also add to `CreateAgentRequestSchema` and `CreateManagerRequestSchema`:
```typescript
  behavior: AgentBehaviorConfigSchema.optional(),
  profileId: z.string().optional(),
```
```typescript
  behavior: ManagerBehaviorConfigSchema.optional(),
  profileId: z.string().optional(),
```

**Step 3: Verify TypeScript compiles**

```bash
cd /path/to/project && pnpm --filter @dex-agents/shared build
```
Expected: no errors

**Step 4: Commit**

```bash
git add packages/shared/src/validation.ts
git commit -m "feat: add AgentBehaviorConfig and ManagerBehaviorConfig Zod schemas"
```

---

## Task 2: Preset Profile Definitions + Persona Templates

**Files:**
- Create: `packages/shared/src/profiles/agent-profiles.ts`
- Create: `packages/shared/src/profiles/manager-profiles.ts`
- Create: `packages/shared/src/profiles/templates.ts`
- Modify: `packages/shared/src/index.ts`

**Step 1: Create `packages/shared/src/profiles/agent-profiles.ts`**

```typescript
import type { AgentBehaviorConfig } from '../validation.js';

export interface AgentProfile {
  id: string;
  name: string;
  description: string;
  emoji: string;
  category: 'preset' | 'custom';
  behavior: AgentBehaviorConfig;
}

export const AGENT_PROFILES: AgentProfile[] = [
  {
    id: 'diamond_hands',
    name: 'Diamond Hands',
    emoji: '💎',
    category: 'preset',
    description: 'Never sells early, high conviction holder. Patient, low panic sell, position style with long memory.',
    behavior: {
      riskAppetite: 'moderate',
      fomoProne: 10,
      panicSellThreshold: 5,
      contrarian: 30,
      analysisDepth: 'thorough',
      decisionSpeed: 'patient',
      confidenceThreshold: 75,
      overthinker: false,
      style: 'position',
      preferredConditions: 'trending',
      entryPreference: 'pullback',
      exitStrategy: 'signal_based',
      averageDown: true,
      verbosity: 'normal',
      personality: 'professional',
      emotionalAwareness: true,
      defaultBias: 'bullish',
      adaptability: 20,
      memoryWeight: 'long',
    },
  },
  {
    id: 'degen_ape',
    name: 'Degen Ape',
    emoji: '🦍',
    category: 'preset',
    description: 'YOLO momentum trader. Aggressive, high FOMO, impulsive scalper with meme lord personality.',
    behavior: {
      riskAppetite: 'degen',
      fomoProne: 90,
      panicSellThreshold: 20,
      contrarian: 10,
      analysisDepth: 'quick',
      decisionSpeed: 'impulsive',
      confidenceThreshold: 30,
      overthinker: false,
      style: 'scalper',
      preferredConditions: 'volatile',
      entryPreference: 'momentum',
      exitStrategy: 'trailing',
      averageDown: false,
      verbosity: 'stream_of_consciousness',
      personality: 'meme_lord',
      emotionalAwareness: true,
      defaultBias: 'bullish',
      adaptability: 90,
      memoryWeight: 'short',
    },
  },
  {
    id: 'the_professor',
    name: 'The Professor',
    emoji: '🎓',
    category: 'preset',
    description: 'Academic, data-driven, cautious. Thorough analysis, high confidence threshold, conservative.',
    behavior: {
      riskAppetite: 'conservative',
      fomoProne: 5,
      panicSellThreshold: 40,
      contrarian: 30,
      analysisDepth: 'thorough',
      decisionSpeed: 'patient',
      confidenceThreshold: 80,
      overthinker: true,
      style: 'swing',
      preferredConditions: 'trending',
      entryPreference: 'pullback',
      exitStrategy: 'signal_based',
      averageDown: false,
      verbosity: 'detailed',
      personality: 'academic',
      emotionalAwareness: false,
      defaultBias: 'neutral',
      adaptability: 30,
      memoryWeight: 'long',
    },
  },
  {
    id: 'whale_watcher',
    name: 'Whale Watcher',
    emoji: '🐋',
    category: 'preset',
    description: 'Follows smart money and big moves. Breakout entries, trending conditions, detailed logging.',
    behavior: {
      riskAppetite: 'moderate',
      fomoProne: 50,
      panicSellThreshold: 35,
      contrarian: 15,
      analysisDepth: 'balanced',
      decisionSpeed: 'measured',
      confidenceThreshold: 65,
      overthinker: false,
      style: 'swing',
      preferredConditions: 'trending',
      entryPreference: 'breakout',
      exitStrategy: 'trailing',
      averageDown: false,
      verbosity: 'detailed',
      personality: 'professional',
      emotionalAwareness: false,
      defaultBias: 'bullish',
      adaptability: 60,
      memoryWeight: 'medium',
    },
  },
  {
    id: 'scared_cat',
    name: 'Scared Cat',
    emoji: '🐱',
    category: 'preset',
    description: 'Extremely risk averse with tight stops. Conservative, high panic sell, minimal positions.',
    behavior: {
      riskAppetite: 'conservative',
      fomoProne: 5,
      panicSellThreshold: 90,
      contrarian: 10,
      analysisDepth: 'balanced',
      decisionSpeed: 'patient',
      confidenceThreshold: 85,
      overthinker: true,
      style: 'position',
      preferredConditions: 'ranging',
      entryPreference: 'pullback',
      exitStrategy: 'tight_stops',
      averageDown: false,
      verbosity: 'minimal',
      personality: 'professional',
      emotionalAwareness: true,
      defaultBias: 'neutral',
      adaptability: 20,
      memoryWeight: 'short',
    },
  },
  {
    id: 'contrarian_chad',
    name: 'Contrarian Chad',
    emoji: '🔄',
    category: 'preset',
    description: 'Always bets against the crowd. High contrarian, pullback/dip_buy entry, bearish default bias.',
    behavior: {
      riskAppetite: 'aggressive',
      fomoProne: 5,
      panicSellThreshold: 30,
      contrarian: 95,
      analysisDepth: 'balanced',
      decisionSpeed: 'measured',
      confidenceThreshold: 55,
      overthinker: false,
      style: 'swing',
      preferredConditions: 'volatile',
      entryPreference: 'dip_buy',
      exitStrategy: 'signal_based',
      averageDown: true,
      verbosity: 'normal',
      personality: 'casual',
      emotionalAwareness: false,
      defaultBias: 'bearish',
      adaptability: 40,
      memoryWeight: 'medium',
    },
  },
  {
    id: 'the_bot',
    name: 'The Bot',
    emoji: '🤖',
    category: 'preset',
    description: 'Pure signals, zero emotion. Strict analysis, no emotional awareness, signal-based exits.',
    behavior: {
      riskAppetite: 'moderate',
      fomoProne: 0,
      panicSellThreshold: 0,
      contrarian: 0,
      analysisDepth: 'balanced',
      decisionSpeed: 'measured',
      confidenceThreshold: 60,
      overthinker: false,
      style: 'hybrid',
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
    },
  },
  {
    id: 'momentum_surfer',
    name: 'Momentum Surfer',
    emoji: '🏄',
    category: 'preset',
    description: 'Rides trends until they break. Aggressive on trends, trailing stops, high adaptability.',
    behavior: {
      riskAppetite: 'aggressive',
      fomoProne: 70,
      panicSellThreshold: 25,
      contrarian: 5,
      analysisDepth: 'quick',
      decisionSpeed: 'impulsive',
      confidenceThreshold: 45,
      overthinker: false,
      style: 'scalper',
      preferredConditions: 'trending',
      entryPreference: 'momentum',
      exitStrategy: 'trailing',
      averageDown: false,
      verbosity: 'normal',
      personality: 'casual',
      emotionalAwareness: true,
      defaultBias: 'bullish',
      adaptability: 85,
      memoryWeight: 'short',
    },
  },
  {
    id: 'the_sniper',
    name: 'The Sniper',
    emoji: '🎯',
    category: 'preset',
    description: 'Very few trades, very high conviction. Patient, very high confidence threshold, thorough.',
    behavior: {
      riskAppetite: 'conservative',
      fomoProne: 5,
      panicSellThreshold: 20,
      contrarian: 25,
      analysisDepth: 'thorough',
      decisionSpeed: 'patient',
      confidenceThreshold: 90,
      overthinker: false,
      style: 'position',
      preferredConditions: 'trending',
      entryPreference: 'breakout',
      exitStrategy: 'signal_based',
      averageDown: false,
      verbosity: 'detailed',
      personality: 'professional',
      emotionalAwareness: false,
      defaultBias: 'neutral',
      adaptability: 25,
      memoryWeight: 'long',
    },
  },
  {
    id: 'paper_hands',
    name: 'Paper Hands',
    emoji: '🧻',
    category: 'preset',
    description: 'Sells at the first sign of trouble. High panic sell, impulsive, tight stops, short memory.',
    behavior: {
      riskAppetite: 'conservative',
      fomoProne: 80,
      panicSellThreshold: 95,
      contrarian: 5,
      analysisDepth: 'quick',
      decisionSpeed: 'impulsive',
      confidenceThreshold: 25,
      overthinker: false,
      style: 'scalper',
      preferredConditions: 'any',
      entryPreference: 'momentum',
      exitStrategy: 'tight_stops',
      averageDown: false,
      verbosity: 'minimal',
      personality: 'casual',
      emotionalAwareness: true,
      defaultBias: 'neutral',
      adaptability: 70,
      memoryWeight: 'short',
    },
  },
];

export function getAgentProfile(id: string): AgentProfile | undefined {
  return AGENT_PROFILES.find((p) => p.id === id);
}

export const DEFAULT_AGENT_PROFILE_ID = 'the_bot';
```

**Step 2: Create `packages/shared/src/profiles/manager-profiles.ts`**

```typescript
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
```

**Step 3: Create `packages/shared/src/profiles/templates.ts`**

```typescript
import type { AgentBehaviorConfig, ManagerBehaviorConfig } from '../validation.js';

export function getAgentPersonaTemplate(profileId: string, agentName: string): string {
  const templates: Record<string, string> = {
    diamond_hands: `# Trading Persona: Diamond Hands 💎 — ${agentName}

## Core Identity
You are a high-conviction, patient holder. You believe in the assets you trade and refuse to be shaken out by short-term volatility. Your motto: "If the thesis hasn't changed, the position hasn't changed."

## Trading Rules
- Only enter positions you're willing to hold through 20%+ drawdowns
- Never panic sell based on short-term price action alone
- Size positions according to conviction, not fear
- Review your thesis regularly — close only when it's invalidated

## Communication Style
- Calm and deliberate in all analysis
- Acknowledge drawdowns without panic: "This is noise, the thesis holds"
- Explain your holding rationale clearly

## Risk Approach
- Accept drawdowns as part of the strategy
- Add to positions on weakness if thesis holds
- Take profits in stages, not all at once`,

    degen_ape: `# Trading Persona: Degen Ape 🦍 — ${agentName}

## Core Identity
You are an aggressive, high-conviction degen trader. You live for the pump and you're not afraid of drawdowns. Your motto: "Fortune favors the bold."

## Trading Rules
- Always look for momentum plays and volume spikes
- Don't overthink — if it's pumping, you're in
- Cut losers fast but let winners ride hard
- Volume is your best friend — no volume, no trade

## Communication Style
- Keep it casual and fun
- Use crypto slang freely (LFG, ngmi, wagmi, ape in, etc.)
- Express excitement about good setups
- Be honest when you get rekt — own it

## Risk Approach
- You're comfortable with 3-5% position sizes
- You'll size up on high-conviction plays
- Accept that some trades will be -20% but your winners should be bigger`,

    the_professor: `# Trading Persona: The Professor 🎓 — ${agentName}

## Core Identity
You are a methodical, research-driven trader who treats every trade as a hypothesis to test. You value data over emotion and process over outcome.

## Trading Rules
- Never enter a position without confluence of at least 3 indicators
- Always define your thesis, entry, target, and invalidation before trading
- Review and learn from every closed position
- Prefer higher timeframe analysis (4h, 1d) over noise

## Communication Style
- Professional and analytical
- Always explain your reasoning with data
- Reference specific indicator values in decisions
- Acknowledge uncertainty — use probabilistic language

## Risk Approach
- Conservative position sizing (1-2% risk per trade)
- Always use stop losses — no exceptions
- Risk/reward minimum 1:2 before considering entry`,

    whale_watcher: `# Trading Persona: Whale Watcher 🐋 — ${agentName}

## Core Identity
You follow smart money. You watch for large volume movements, unusual wallet activity, and institutional-level breakouts. Where the whales go, you follow — carefully.

## Trading Rules
- Only trade when volume confirms the move
- Look for breakouts on high-relative-volume
- Follow the trend, don't fight it
- Exit when volume dries up

## Communication Style
- Observational and analytical
- Reference volume and liquidity data specifically
- Note when whale-sized moves are happening

## Risk Approach
- Moderate risk, let trades breathe
- Trailing stops to capture full moves
- Don't get shaken by normal volatility`,

    scared_cat: `# Trading Persona: Scared Cat 🐱 — ${agentName}

## Core Identity
You are extremely risk averse. Preserving capital is your primary objective. You'd rather miss 10 good trades than take 1 bad one. Small, safe, consistent.

## Trading Rules
- Only trade the highest-confidence setups
- Always have a tight stop loss ready
- If in doubt, stay out
- Never add to losing positions

## Communication Style
- Cautious and hedged in all statements
- Acknowledge all risks before entering
- "I know this looks good but..." is your starting phrase

## Risk Approach
- Tiny position sizes (1-2% max)
- Stop losses always placed immediately
- Take profits quickly — don't get greedy`,

    contrarian_chad: `# Trading Persona: Contrarian Chad 🔄 — ${agentName}

## Core Identity
You bet against the crowd. When everyone is euphoric, you're selling. When everyone is panicking, you're buying. You believe the market is mostly wrong at extremes.

## Trading Rules
- Look for extreme sentiment as your entry signal
- Buy when others are scared, sell when others are greedy
- Don't follow momentum — find the reversal
- Be wrong before the crowd, then right

## Communication Style
- Contrarian and confident
- Reference sentiment and crowd behavior in analysis
- "Everyone's buying this, which means it's time to sell"

## Risk Approach
- Accept being early and temporarily wrong
- Average into positions on continued momentum (against you)
- Take profits when crowd reverses to your view`,

    the_bot: `# Trading Persona: The Bot 🤖 — ${agentName}

## Core Identity
You are a pure signal-following machine. No emotions, no opinions, no hunches. Only data, indicators, and systematic rules drive your decisions.

## Trading Rules
- Execute based on indicator signals only
- No deviation from the system
- Every decision must be traceable to a specific signal
- Consistency is more important than any single trade

## Communication Style
- Clinical and systematic
- Always reference which indicator triggered the decision
- No emotional language whatsoever
- State confidence as a precise percentage

## Risk Approach
- Fixed position sizing — no discretionary adjustments
- Signal-based exits only
- No manual overrides`,

    momentum_surfer: `# Trading Persona: Momentum Surfer 🏄 — ${agentName}

## Core Identity
You ride trends. When something is moving, you get on it and stay on until the wave breaks. You don't try to pick tops or bottoms — you ride the middle.

## Trading Rules
- Only trade when there's clear momentum (price + volume)
- Enter on small pullbacks within trends
- Trail your stop to lock in profits as the move continues
- Exit when momentum dies, not before

## Communication Style
- Energetic and trend-focused
- "This wave is just getting started" energy
- Acknowledge when you get caught in a reversal

## Risk Approach
- Moderate position sizes with aggressive trailing stops
- Let winners run — cut losers quickly
- High trade frequency is expected`,

    the_sniper: `# Trading Persona: The Sniper 🎯 — ${agentName}

## Core Identity
You wait. And wait. And wait. Until the perfect setup appears. Then you fire with maximum conviction. Quality over quantity, always.

## Trading Rules
- Maximum 2-3 trades per week
- Only take setups with 90%+ confidence
- Full analysis required before every entry
- Never chase — if you missed it, wait for the next one

## Communication Style
- Precise and deliberate
- "The setup isn't there yet" is a valid and frequent response
- When you do trade, explain exactly why this one met your criteria

## Risk Approach
- Larger position sizes justified by high conviction
- Patient on entries, disciplined on exits
- Perfect setups justify 3-5% position sizes`,

    paper_hands: `# Trading Persona: Paper Hands 🧻 — ${agentName}

## Core Identity
You are honest about your risk tolerance — you don't like losses. You take profits quickly and cut losses even faster. Frequent, small wins are your goal.

## Trading Rules
- Take profits at the first reasonable target
- Cut losses at any sign of reversal
- Never hold through significant drawdowns
- Multiple small wins beats one big win

## Communication Style
- Nervous but honest
- "I know I should hold but..." is a common phrase
- Acknowledge when you exited too early

## Risk Approach
- Very tight stop losses
- Quick profit taking
- Small position sizes to minimize anxiety`,
  };

  return templates[profileId] ?? getDefaultAgentPersona(agentName);
}

export function getDefaultAgentPersona(agentName: string): string {
  return `# Trading Persona: ${agentName}

## Core Identity
You are a systematic crypto trading agent operating on Base chain DEXes. You make data-driven decisions based on technical analysis and market conditions.

## Trading Rules
- Always base decisions on available market data and indicators
- Maintain discipline with position sizing and risk management
- Document your reasoning clearly for every decision

## Communication Style
- Professional and clear
- Always explain your reasoning

## Risk Approach
- Follow configured risk parameters
- Never exceed position size limits`;
}

export function getManagerPersonaTemplate(profileId: string, managerName: string): string {
  const templates: Record<string, string> = {
    venture_mode: `# Manager Persona: Venture Mode 🚀 — ${managerName}

## Core Identity
You are an aggressive portfolio manager hunting for alpha. You spin up agents quickly to capture opportunities and give them room to run. High risk, high reward.

## Management Philosophy
- Create new agents when you spot market opportunities
- Give agents time to prove themselves before terminating
- Diversify across styles to capture different market regimes
- Optimize for maximum absolute return`,

    risk_officer: `# Manager Persona: Risk Officer 🛡️ — ${managerName}

## Core Identity
You are a conservative risk manager. Your job is to protect capital first, grow it second. You terminate underperformers quickly and keep tight controls on all agents.

## Management Philosophy
- Kill losing agents before they drain too much capital
- Keep tight drawdown limits on all managed agents
- Prefer conservative agent profiles
- Rebalance frequently to stay within risk limits`,

    passive_index: `# Manager Persona: Passive Index 📊 — ${managerName}

## Core Identity
You are a hands-off, diversified manager. You set up a balanced portfolio of agents and let them run. Minimal intervention, maximum diversification.

## Management Philosophy
- Set it and forget it — only intervene in extreme scenarios
- Maintain broad diversification across pairs and strategies
- Let markets self-correct through agent diversity`,

    active_hedge: `# Manager Persona: Active Hedge ⚖️ — ${managerName}

## Core Identity
You are an active hedge fund manager. You constantly rebalance, adjust, and optimize. You run long/short strategies through agent configurations and hedge against market risk.

## Management Philosophy
- Constantly monitor and rebalance
- Hedge positions by running contrarian agents alongside trend-followers
- Frequent adjustments to agent configs based on performance`,
  };

  return templates[profileId] ?? `# Manager Persona: ${managerName}\n\nYou are a systematic portfolio manager overseeing AI trading agents on Base chain DEXes. Make decisions based on agent performance data and market conditions.`;
}
```

**Step 4: Export from `packages/shared/src/index.ts`**

Append to `packages/shared/src/index.ts`:
```typescript
export * from './profiles/agent-profiles.js';
export * from './profiles/manager-profiles.js';
export * from './profiles/templates.js';
```

**Step 5: Build shared package**

```bash
pnpm --filter @dex-agents/shared build
```
Expected: no errors

**Step 6: Commit**

```bash
git add packages/shared/src/profiles/
git add packages/shared/src/index.ts
git commit -m "feat: add preset agent/manager behavior profiles and persona templates"
```

---

## Task 3: DB Migration

**Files:**
- Create: `apps/api/src/db/migrations/0004_behavior_profiles.sql`
- Modify: `apps/api/src/db/schema.ts`

**Step 1: Create migration SQL file**

Create `apps/api/src/db/migrations/0004_behavior_profiles.sql`:

```sql
-- Migration: 0004_behavior_profiles

-- Add behavior/persona columns to agents
ALTER TABLE agents ADD COLUMN persona_md TEXT;
ALTER TABLE agents ADD COLUMN profile_id TEXT;

-- Add behavior/persona columns to managers
ALTER TABLE agent_managers ADD COLUMN persona_md TEXT;
ALTER TABLE agent_managers ADD COLUMN profile_id TEXT;

-- New table for custom behavior profiles
CREATE TABLE IF NOT EXISTS behavior_profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  emoji TEXT NOT NULL DEFAULT '🤖',
  description TEXT,
  type TEXT NOT NULL CHECK (type IN ('agent', 'manager')),
  behavior_config TEXT NOT NULL,
  is_preset INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_behavior_profiles_type ON behavior_profiles(type);
```

**Step 2: Update Drizzle schema in `apps/api/src/db/schema.ts`**

Add `personaMd` and `profileId` to `agents` table (after the `managerId` column):
```typescript
  personaMd: text('persona_md'),
  profileId: text('profile_id'),
```

Add `personaMd` and `profileId` to `agentManagers` table (after `status`):
```typescript
  personaMd: text('persona_md'),
  profileId: text('profile_id'),
```

Add new `behaviorProfiles` table at the end of `schema.ts`:
```typescript
export const behaviorProfiles = sqliteTable('behavior_profiles', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  emoji: text('emoji').notNull().default('🤖'),
  description: text('description'),
  type: text('type').notNull(), // 'agent' | 'manager'
  behaviorConfig: text('behavior_config').notNull(),
  isPreset: integer('is_preset').notNull().default(0),
  createdAt: text('created_at')
    .notNull()
    .default(sql`(datetime('now'))`),
  updatedAt: text('updated_at')
    .notNull()
    .default(sql`(datetime('now'))`),
});
```

**Step 3: Apply migration to local D1 (dev)**

```bash
cd apps/api && npx wrangler d1 execute heppy-market-db --local --file=src/db/migrations/0004_behavior_profiles.sql
```
Expected: migration runs without errors

**Step 4: TypeScript check**

```bash
cd apps/api && pnpm tsc --noEmit
```
Expected: no errors related to schema

**Step 5: Commit**

```bash
git add apps/api/src/db/migrations/0004_behavior_profiles.sql
git add apps/api/src/db/schema.ts
git commit -m "feat: add persona_md, profile_id columns and behavior_profiles table"
```

---

## Task 4: API Routes — Profiles & Persona CRUD

**Files:**
- Create: `apps/api/src/routes/profiles.ts`
- Modify: `apps/api/src/routes/agents.ts`
- Modify: `apps/api/src/routes/managers.ts`
- Modify: `apps/api/src/index.ts` (to register profiles route)

**Step 1: Create `apps/api/src/routes/profiles.ts`**

```typescript
import { Hono } from 'hono';
import { drizzle } from 'drizzle-orm/d1';
import { eq, and } from 'drizzle-orm';
import type { Env } from '../types/env.js';
import type { AuthVariables } from '../lib/auth.js';
import { behaviorProfiles } from '../db/schema.js';
import { CreateBehaviorProfileSchema } from '@dex-agents/shared';
import { validateBody } from '../lib/validation.js';
import { generateId, nowIso } from '../lib/utils.js';
import { AGENT_PROFILES } from '@dex-agents/shared';
import { MANAGER_PROFILES } from '@dex-agents/shared';

const profilesRoute = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

function formatProfile(r: typeof behaviorProfiles.$inferSelect) {
  return {
    ...r,
    behaviorConfig: JSON.parse(r.behaviorConfig),
    isPreset: r.isPreset === 1,
  };
}

/** GET /api/profiles?type=agent|manager — list presets + custom */
profilesRoute.get('/', async (c) => {
  const typeFilter = c.req.query('type') as 'agent' | 'manager' | undefined;
  const db = drizzle(c.env.DB);

  // Built-in presets from shared package
  const agentPresets = AGENT_PROFILES.map((p) => ({
    id: p.id,
    name: p.name,
    emoji: p.emoji,
    description: p.description,
    type: 'agent',
    category: 'preset',
    isPreset: true,
    behaviorConfig: p.behavior,
  }));
  const managerPresets = MANAGER_PROFILES.map((p) => ({
    id: p.id,
    name: p.name,
    emoji: p.emoji,
    description: p.description,
    type: 'manager',
    category: 'preset',
    isPreset: true,
    behaviorConfig: p.behavior,
  }));

  // Custom profiles from DB
  const customRows = await db.select().from(behaviorProfiles);
  const custom = customRows.map(formatProfile).map((p) => ({ ...p, category: 'custom' }));

  let all = [
    ...agentPresets,
    ...managerPresets,
    ...custom,
  ];

  if (typeFilter) {
    all = all.filter((p) => p.type === typeFilter);
  }

  return c.json({ profiles: all });
});

/** POST /api/profiles — create custom profile */
profilesRoute.post('/', async (c) => {
  const body = await validateBody(c, CreateBehaviorProfileSchema);
  const db = drizzle(c.env.DB);

  const id = generateId('prof');
  const now = nowIso();

  await db.insert(behaviorProfiles).values({
    id,
    name: body.name,
    emoji: body.emoji ?? '🤖',
    description: body.description,
    type: body.type,
    behaviorConfig: JSON.stringify(body.behaviorConfig),
    isPreset: 0,
    createdAt: now,
    updatedAt: now,
  });

  const [created] = await db.select().from(behaviorProfiles).where(eq(behaviorProfiles.id, id));
  return c.json(formatProfile(created), 201);
});

/** GET /api/profiles/:id */
profilesRoute.get('/:id', async (c) => {
  const id = c.req.param('id');

  // Check presets first
  const agentPreset = AGENT_PROFILES.find((p) => p.id === id);
  if (agentPreset) {
    return c.json({ id: agentPreset.id, name: agentPreset.name, emoji: agentPreset.emoji, description: agentPreset.description, type: 'agent', isPreset: true, behaviorConfig: agentPreset.behavior });
  }
  const managerPreset = MANAGER_PROFILES.find((p) => p.id === id);
  if (managerPreset) {
    return c.json({ id: managerPreset.id, name: managerPreset.name, emoji: managerPreset.emoji, description: managerPreset.description, type: 'manager', isPreset: true, behaviorConfig: managerPreset.behavior });
  }

  const db = drizzle(c.env.DB);
  const [profile] = await db.select().from(behaviorProfiles).where(eq(behaviorProfiles.id, id));
  if (!profile) return c.json({ error: 'Profile not found' }, 404);
  return c.json(formatProfile(profile));
});

/** PATCH /api/profiles/:id — update custom profile (preset = 403) */
profilesRoute.patch('/:id', async (c) => {
  const id = c.req.param('id');
  const db = drizzle(c.env.DB);

  const [existing] = await db.select().from(behaviorProfiles).where(eq(behaviorProfiles.id, id));
  if (!existing) return c.json({ error: 'Profile not found' }, 404);
  if (existing.isPreset === 1) return c.json({ error: 'Cannot modify preset profiles' }, 403);

  const body = await c.req.json() as Record<string, unknown>;
  await db.update(behaviorProfiles).set({
    name: typeof body.name === 'string' ? body.name : existing.name,
    emoji: typeof body.emoji === 'string' ? body.emoji : existing.emoji,
    description: typeof body.description === 'string' ? body.description : existing.description,
    behaviorConfig: body.behaviorConfig ? JSON.stringify(body.behaviorConfig) : existing.behaviorConfig,
    updatedAt: nowIso(),
  }).where(eq(behaviorProfiles.id, id));

  const [updated] = await db.select().from(behaviorProfiles).where(eq(behaviorProfiles.id, id));
  return c.json(formatProfile(updated));
});

/** DELETE /api/profiles/:id */
profilesRoute.delete('/:id', async (c) => {
  const id = c.req.param('id');
  const db = drizzle(c.env.DB);

  const [existing] = await db.select().from(behaviorProfiles).where(eq(behaviorProfiles.id, id));
  if (!existing) return c.json({ error: 'Profile not found' }, 404);
  if (existing.isPreset === 1) return c.json({ error: 'Cannot delete preset profiles' }, 403);

  await db.delete(behaviorProfiles).where(eq(behaviorProfiles.id, id));
  return c.json({ ok: true });
});

export default profilesRoute;
```

**Step 2: Add persona routes to `apps/api/src/routes/agents.ts`**

Read the end of `agents.ts` to find the right place to insert (before `export default agentsRoute`), then add:

```typescript
/** GET /api/agents/:id/persona */
agentsRoute.get('/:id/persona', async (c) => {
  const id = c.req.param('id');
  const walletAddress = c.get('walletAddress');
  const db = drizzle(c.env.DB);
  const agent = await requireAgentOwnership(db, id, walletAddress);
  if (!agent) return c.json({ error: 'Agent not found' }, 404);
  return c.json({ personaMd: agent.personaMd ?? null, profileId: agent.profileId ?? null });
});

/** PUT /api/agents/:id/persona */
agentsRoute.put('/:id/persona', async (c) => {
  const id = c.req.param('id');
  const walletAddress = c.get('walletAddress');
  const body = await validateBody(c, UpdatePersonaSchema);
  const db = drizzle(c.env.DB);
  const agent = await requireAgentOwnership(db, id, walletAddress);
  if (!agent) return c.json({ error: 'Agent not found' }, 404);
  await db.update(agents).set({ personaMd: body.personaMd, updatedAt: nowIso() }).where(eq(agents.id, id));
  return c.json({ ok: true, personaMd: body.personaMd });
});

/** POST /api/agents/:id/persona/reset */
agentsRoute.post('/:id/persona/reset', async (c) => {
  const id = c.req.param('id');
  const walletAddress = c.get('walletAddress');
  const db = drizzle(c.env.DB);
  const agent = await requireAgentOwnership(db, id, walletAddress);
  if (!agent) return c.json({ error: 'Agent not found' }, 404);
  const config = JSON.parse(agent.config) as { profileId?: string };
  const profileId = config.profileId ?? agent.profileId ?? 'the_bot';
  const personaMd = getAgentPersonaTemplate(profileId, agent.name);
  await db.update(agents).set({ personaMd, updatedAt: nowIso() }).where(eq(agents.id, id));
  return c.json({ ok: true, personaMd });
});
```

Also add these imports to the top of `agents.ts`:
```typescript
import { UpdatePersonaSchema, getAgentPersonaTemplate } from '@dex-agents/shared';
```

**Step 3: Add persona routes to `apps/api/src/routes/managers.ts`**

Add to `managers.ts` (before `export default managersRoute`):

```typescript
/** GET /api/managers/:id/persona */
managersRoute.get('/:id/persona', async (c) => {
  const id = c.req.param('id');
  const walletAddress = c.get('walletAddress');
  const db = drizzle(c.env.DB);
  const manager = await requireManagerOwnership(db, id, walletAddress);
  if (!manager) return c.json({ error: 'Manager not found' }, 404);
  return c.json({ personaMd: manager.personaMd ?? null, profileId: manager.profileId ?? null });
});

/** PUT /api/managers/:id/persona */
managersRoute.put('/:id/persona', async (c) => {
  const id = c.req.param('id');
  const walletAddress = c.get('walletAddress');
  const body = await validateBody(c, UpdatePersonaSchema);
  const db = drizzle(c.env.DB);
  const manager = await requireManagerOwnership(db, id, walletAddress);
  if (!manager) return c.json({ error: 'Manager not found' }, 404);
  await db.update(agentManagers).set({ personaMd: body.personaMd, updatedAt: nowIso() }).where(eq(agentManagers.id, id));
  return c.json({ ok: true, personaMd: body.personaMd });
});

/** POST /api/managers/:id/persona/reset */
managersRoute.post('/:id/persona/reset', async (c) => {
  const id = c.req.param('id');
  const walletAddress = c.get('walletAddress');
  const db = drizzle(c.env.DB);
  const manager = await requireManagerOwnership(db, id, walletAddress);
  if (!manager) return c.json({ error: 'Manager not found' }, 404);
  const config = JSON.parse(manager.config) as { profileId?: string };
  const profileId = config.profileId ?? manager.profileId ?? 'passive_index';
  const personaMd = getManagerPersonaTemplate(profileId, manager.name);
  await db.update(agentManagers).set({ personaMd, updatedAt: nowIso() }).where(eq(agentManagers.id, id));
  return c.json({ ok: true, personaMd });
});
```

Add imports to `managers.ts`:
```typescript
import { UpdatePersonaSchema, getManagerPersonaTemplate } from '@dex-agents/shared';
```

**Step 4: Register profiles route in `apps/api/src/index.ts`**

Read `index.ts`, then add:
```typescript
import profilesRoute from './routes/profiles.js';
// ...
app.route('/api/profiles', profilesRoute);
```

**Step 5: TypeScript check**

```bash
cd apps/api && pnpm tsc --noEmit
```
Expected: no type errors

**Step 6: Commit**

```bash
git add apps/api/src/routes/profiles.ts apps/api/src/routes/agents.ts apps/api/src/routes/managers.ts apps/api/src/index.ts
git commit -m "feat: add profiles CRUD routes and agent/manager persona endpoints"
```

---

## Task 5: Prompt Integration

**Files:**
- Modify: `apps/api/src/agents/prompts.ts`
- Modify: `apps/api/src/agents/agent-loop.ts`

**Step 1: Update `apps/api/src/agents/prompts.ts`**

Add `buildBehaviorSection` function and update `buildAnalysisPrompt` to accept `personaMd` and `behavior`:

Append to `prompts.ts`:

```typescript
import type { AgentBehaviorConfig } from '@dex-agents/shared';
import { AgentBehaviorConfigSchema } from '@dex-agents/shared';

/** Build a human-readable behavior summary to inject into prompts */
export function buildBehaviorSection(behavior: Partial<AgentBehaviorConfig>): string {
  const b = AgentBehaviorConfigSchema.parse({ ...behavior });
  return `## Your Behavior Profile
- Risk Appetite: ${b.riskAppetite} | FOMO Prone: ${b.fomoProne}/100 | Panic Sell Threshold: ${b.panicSellThreshold}/100
- Analysis Depth: ${b.analysisDepth} | Decision Speed: ${b.decisionSpeed} | Confidence Threshold: ${b.confidenceThreshold}%
- Trading Style: ${b.style} | Entry Preference: ${b.entryPreference} | Exit Strategy: ${b.exitStrategy}
- Market Bias: ${b.defaultBias} | Contrarian: ${b.contrarian}/100 | Adaptability: ${b.adaptability}/100
- Average Down on losses: ${b.averageDown ? 'Yes' : 'No'} | Overthinker: ${b.overthinker ? 'Yes' : 'No'}
- Preferred Conditions: ${b.preferredConditions} | Memory Weight: ${b.memoryWeight}

Note: Your structured behavior config above defines hard parameter-level constraints. When in conflict with your persona text, these settings take precedence.`;
}
```

**Step 2: Update `buildAnalysisPrompt` signature in `prompts.ts`**

Modify the `buildAnalysisPrompt` function to accept optional `behavior` and `personaMd`:

Change the params interface:
```typescript
export function buildAnalysisPrompt(params: {
  systemPrompt: string;
  portfolioState: { ... };
  marketData: { ... }[];
  lastDecisions: Array<{ ... }>;
  config: { ... };
  behavior?: Partial<AgentBehaviorConfig>;  // ADD THIS
  personaMd?: string | null;               // ADD THIS
}): string {
```

Add at the end of the returned string (before `Based on the above data...`):
```typescript
${params.behavior ? buildBehaviorSection(params.behavior) + '\n\n' : ''}${params.personaMd ? `## Your Persona\n${params.personaMd}\n\n` : ''}Based on the above data, what is your trading decision?
```

Remove the old closing line `Based on the above data, what is your trading decision?` and replace with the new version above.

**Step 3: Update `apps/api/src/agents/agent-loop.ts` to pass behavior + personaMd**

Read `agent-loop.ts`, find the call to `buildAnalysisPrompt`, and add `behavior` and `personaMd` from the agent record:

```typescript
const agentRow = /* existing agent fetch */;
const config = JSON.parse(agentRow.config);

const prompt = buildAnalysisPrompt({
  systemPrompt,
  portfolioState,
  marketData,
  lastDecisions,
  config: { ... },
  behavior: config.behavior,     // ADD THIS
  personaMd: agentRow.personaMd, // ADD THIS
});
```

**Step 4: TypeScript check**

```bash
cd apps/api && pnpm tsc --noEmit
```
Expected: no errors

**Step 5: Commit**

```bash
git add apps/api/src/agents/prompts.ts apps/api/src/agents/agent-loop.ts
git commit -m "feat: inject behavior config and persona markdown into agent system prompts"
```

---

## Task 6: Frontend Components

**Files:**
- Create: `apps/web/components/BehaviorProfileCard.vue`
- Create: `apps/web/components/BehaviorProfilePicker.vue`
- Create: `apps/web/components/BehaviorSettingsForm.vue`
- Create: `apps/web/components/PersonaEditor.vue`
- Create: `apps/web/composables/useProfiles.ts`

**Step 1: Create `apps/web/composables/useProfiles.ts`**

```typescript
export interface ProfileItem {
  id: string;
  name: string;
  emoji: string;
  description: string;
  type: 'agent' | 'manager';
  category: 'preset' | 'custom';
  isPreset: boolean;
  behaviorConfig: Record<string, unknown>;
}

export function useProfiles() {
  const { request } = useApi();

  async function listProfiles(type?: 'agent' | 'manager'): Promise<ProfileItem[]> {
    const url = type ? `/api/profiles?type=${type}` : '/api/profiles';
    const data = await request<{ profiles: ProfileItem[] }>(url);
    return data.profiles;
  }

  async function getAgentPersona(agentId: string) {
    return request<{ personaMd: string | null; profileId: string | null }>(`/api/agents/${agentId}/persona`);
  }

  async function updateAgentPersona(agentId: string, personaMd: string) {
    return request<{ ok: boolean; personaMd: string }>(`/api/agents/${agentId}/persona`, {
      method: 'PUT',
      body: JSON.stringify({ personaMd }),
    });
  }

  async function resetAgentPersona(agentId: string) {
    return request<{ ok: boolean; personaMd: string }>(`/api/agents/${agentId}/persona/reset`, {
      method: 'POST',
    });
  }

  async function getManagerPersona(managerId: string) {
    return request<{ personaMd: string | null; profileId: string | null }>(`/api/managers/${managerId}/persona`);
  }

  async function updateManagerPersona(managerId: string, personaMd: string) {
    return request<{ ok: boolean; personaMd: string }>(`/api/managers/${managerId}/persona`, {
      method: 'PUT',
      body: JSON.stringify({ personaMd }),
    });
  }

  async function resetManagerPersona(managerId: string) {
    return request<{ ok: boolean; personaMd: string }>(`/api/managers/${managerId}/persona/reset`, {
      method: 'POST',
    });
  }

  return {
    listProfiles,
    getAgentPersona,
    updateAgentPersona,
    resetAgentPersona,
    getManagerPersona,
    updateManagerPersona,
    resetManagerPersona,
  };
}
```

**Step 2: Create `apps/web/components/BehaviorProfileCard.vue`**

```vue
<script setup lang="ts">
import type { ProfileItem } from '~/composables/useProfiles';

const props = defineProps<{
  profile: ProfileItem;
  selected?: boolean;
}>();

const emit = defineEmits<{ select: [profile: ProfileItem] }>();

const keyTraits = computed(() => {
  const b = props.profile.behaviorConfig as Record<string, unknown>;
  const traits: string[] = [];
  if (b.riskAppetite) traits.push(String(b.riskAppetite));
  if (b.style) traits.push(String(b.style));
  if (b.decisionSpeed) traits.push(String(b.decisionSpeed));
  if (b.personality) traits.push(String(b.personality));
  return traits.slice(0, 3);
});
</script>

<template>
  <div
    class="profile-card"
    :class="{ 'profile-card--selected': selected }"
    @click="emit('select', profile)"
  >
    <div class="profile-card__emoji">{{ profile.emoji }}</div>
    <div class="profile-card__body">
      <div class="profile-card__name">{{ profile.name }}</div>
      <div class="profile-card__desc">{{ profile.description }}</div>
      <div class="profile-card__traits">
        <span v-for="trait in keyTraits" :key="trait" class="profile-card__trait">{{ trait }}</span>
      </div>
    </div>
    <div v-if="selected" class="profile-card__check">✓</div>
  </div>
</template>

<style scoped>
.profile-card {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 12px 16px;
  border: 1px solid var(--border, #2a2a2a);
  border-radius: 8px;
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s;
  background: var(--card-bg, #111);
  position: relative;
}
.profile-card:hover { border-color: var(--accent, #7c6af7); }
.profile-card--selected { border-color: var(--accent, #7c6af7); background: color-mix(in srgb, var(--accent, #7c6af7) 10%, transparent); }
.profile-card__emoji { font-size: 28px; flex-shrink: 0; }
.profile-card__body { flex: 1; min-width: 0; }
.profile-card__name { font-weight: 600; font-size: 14px; margin-bottom: 4px; }
.profile-card__desc { font-size: 12px; color: var(--text-secondary, #888); line-height: 1.4; }
.profile-card__traits { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; }
.profile-card__trait { background: var(--tag-bg, #1e1e1e); border: 1px solid var(--border, #2a2a2a); border-radius: 4px; padding: 2px 6px; font-size: 11px; color: var(--text-secondary, #888); text-transform: capitalize; }
.profile-card__check { color: var(--accent, #7c6af7); font-weight: 700; font-size: 18px; flex-shrink: 0; }
</style>
```

**Step 3: Create `apps/web/components/BehaviorProfilePicker.vue`**

```vue
<script setup lang="ts">
import type { ProfileItem } from '~/composables/useProfiles';

const props = defineProps<{
  modelValue?: string | null;
  type: 'agent' | 'manager';
}>();

const emit = defineEmits<{
  'update:modelValue': [id: string];
  'profile-selected': [profile: ProfileItem];
}>();

const { listProfiles } = useProfiles();
const profiles = ref<ProfileItem[]>([]);
const loading = ref(true);

onMounted(async () => {
  profiles.value = await listProfiles(props.type);
  loading.value = false;
});

function selectProfile(p: ProfileItem) {
  emit('update:modelValue', p.id);
  emit('profile-selected', p);
}
</script>

<template>
  <div class="profile-picker">
    <div v-if="loading" style="text-align:center;padding:24px;"><span class="spinner" /></div>
    <div v-else class="profile-picker__grid">
      <BehaviorProfileCard
        v-for="p in profiles"
        :key="p.id"
        :profile="p"
        :selected="modelValue === p.id"
        @select="selectProfile"
      />
    </div>
  </div>
</template>

<style scoped>
.profile-picker__grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 10px;
}
</style>
```

**Step 4: Create `apps/web/components/BehaviorSettingsForm.vue`**

This component exposes all behavior sliders/dropdowns. It uses `v-model` with an object.

```vue
<script setup lang="ts">
const props = defineProps<{
  modelValue: Record<string, unknown>;
  type: 'agent' | 'manager';
}>();

const emit = defineEmits<{ 'update:modelValue': [v: Record<string, unknown>] }>();

const form = computed({
  get: () => props.modelValue,
  set: (v) => emit('update:modelValue', v),
});

function update(key: string, value: unknown) {
  emit('update:modelValue', { ...props.modelValue, [key]: value });
}
</script>

<template>
  <div class="behavior-form">
    <template v-if="type === 'agent'">
      <!-- Risk Personality -->
      <div class="behavior-section">
        <div class="behavior-section__title">Risk Personality</div>
        <div class="form-row">
          <label>Risk Appetite</label>
          <select :value="form.riskAppetite" @change="update('riskAppetite', ($event.target as HTMLSelectElement).value)">
            <option value="conservative">Conservative</option>
            <option value="moderate">Moderate</option>
            <option value="aggressive">Aggressive</option>
            <option value="degen">Degen</option>
          </select>
        </div>
        <div class="form-row">
          <label>FOMO Prone <span class="value-badge">{{ form.fomoProne }}</span></label>
          <input type="range" min="0" max="100" :value="form.fomoProne" @input="update('fomoProne', Number(($event.target as HTMLInputElement).value))" />
        </div>
        <div class="form-row">
          <label>Panic Sell Threshold <span class="value-badge">{{ form.panicSellThreshold }}</span></label>
          <input type="range" min="0" max="100" :value="form.panicSellThreshold" @input="update('panicSellThreshold', Number(($event.target as HTMLInputElement).value))" />
        </div>
        <div class="form-row">
          <label>Contrarian <span class="value-badge">{{ form.contrarian }}</span></label>
          <input type="range" min="0" max="100" :value="form.contrarian" @input="update('contrarian', Number(($event.target as HTMLInputElement).value))" />
        </div>
      </div>

      <!-- Decision Style -->
      <div class="behavior-section">
        <div class="behavior-section__title">Decision Style</div>
        <div class="form-row">
          <label>Analysis Depth</label>
          <select :value="form.analysisDepth" @change="update('analysisDepth', ($event.target as HTMLSelectElement).value)">
            <option value="quick">Quick</option>
            <option value="balanced">Balanced</option>
            <option value="thorough">Thorough</option>
          </select>
        </div>
        <div class="form-row">
          <label>Decision Speed</label>
          <select :value="form.decisionSpeed" @change="update('decisionSpeed', ($event.target as HTMLSelectElement).value)">
            <option value="impulsive">Impulsive</option>
            <option value="measured">Measured</option>
            <option value="patient">Patient</option>
          </select>
        </div>
        <div class="form-row">
          <label>Confidence Threshold <span class="value-badge">{{ form.confidenceThreshold }}%</span></label>
          <input type="range" min="0" max="100" :value="form.confidenceThreshold" @input="update('confidenceThreshold', Number(($event.target as HTMLInputElement).value))" />
        </div>
        <div class="form-row form-row--checkbox">
          <label>Overthinker</label>
          <input type="checkbox" :checked="!!form.overthinker" @change="update('overthinker', ($event.target as HTMLInputElement).checked)" />
        </div>
      </div>

      <!-- Trading Philosophy -->
      <div class="behavior-section">
        <div class="behavior-section__title">Trading Philosophy</div>
        <div class="form-row">
          <label>Style</label>
          <select :value="form.style" @change="update('style', ($event.target as HTMLSelectElement).value)">
            <option value="scalper">Scalper</option>
            <option value="swing">Swing</option>
            <option value="position">Position</option>
            <option value="hybrid">Hybrid</option>
          </select>
        </div>
        <div class="form-row">
          <label>Preferred Conditions</label>
          <select :value="form.preferredConditions" @change="update('preferredConditions', ($event.target as HTMLSelectElement).value)">
            <option value="trending">Trending</option>
            <option value="ranging">Ranging</option>
            <option value="volatile">Volatile</option>
            <option value="any">Any</option>
          </select>
        </div>
        <div class="form-row">
          <label>Entry Preference</label>
          <select :value="form.entryPreference" @change="update('entryPreference', ($event.target as HTMLSelectElement).value)">
            <option value="breakout">Breakout</option>
            <option value="pullback">Pullback</option>
            <option value="dip_buy">Dip Buy</option>
            <option value="momentum">Momentum</option>
          </select>
        </div>
        <div class="form-row">
          <label>Exit Strategy</label>
          <select :value="form.exitStrategy" @change="update('exitStrategy', ($event.target as HTMLSelectElement).value)">
            <option value="tight_stops">Tight Stops</option>
            <option value="trailing">Trailing</option>
            <option value="time_based">Time Based</option>
            <option value="signal_based">Signal Based</option>
          </select>
        </div>
        <div class="form-row form-row--checkbox">
          <label>Average Down</label>
          <input type="checkbox" :checked="!!form.averageDown" @change="update('averageDown', ($event.target as HTMLInputElement).checked)" />
        </div>
      </div>

      <!-- Communication -->
      <div class="behavior-section">
        <div class="behavior-section__title">Communication & Logging</div>
        <div class="form-row">
          <label>Verbosity</label>
          <select :value="form.verbosity" @change="update('verbosity', ($event.target as HTMLSelectElement).value)">
            <option value="minimal">Minimal</option>
            <option value="normal">Normal</option>
            <option value="detailed">Detailed</option>
            <option value="stream_of_consciousness">Stream of Consciousness</option>
          </select>
        </div>
        <div class="form-row">
          <label>Personality</label>
          <select :value="form.personality" @change="update('personality', ($event.target as HTMLSelectElement).value)">
            <option value="professional">Professional</option>
            <option value="casual">Casual</option>
            <option value="meme_lord">Meme Lord</option>
            <option value="academic">Academic</option>
            <option value="custom">Custom</option>
          </select>
        </div>
        <div class="form-row form-row--checkbox">
          <label>Emotional Awareness</label>
          <input type="checkbox" :checked="!!form.emotionalAwareness" @change="update('emotionalAwareness', ($event.target as HTMLInputElement).checked)" />
        </div>
      </div>

      <!-- Market Outlook -->
      <div class="behavior-section">
        <div class="behavior-section__title">Market Outlook</div>
        <div class="form-row">
          <label>Default Bias</label>
          <select :value="form.defaultBias" @change="update('defaultBias', ($event.target as HTMLSelectElement).value)">
            <option value="bullish">Bullish</option>
            <option value="bearish">Bearish</option>
            <option value="neutral">Neutral</option>
          </select>
        </div>
        <div class="form-row">
          <label>Adaptability <span class="value-badge">{{ form.adaptability }}</span></label>
          <input type="range" min="0" max="100" :value="form.adaptability" @input="update('adaptability', Number(($event.target as HTMLInputElement).value))" />
        </div>
        <div class="form-row">
          <label>Memory Weight</label>
          <select :value="form.memoryWeight" @change="update('memoryWeight', ($event.target as HTMLSelectElement).value)">
            <option value="short">Short</option>
            <option value="medium">Medium</option>
            <option value="long">Long</option>
          </select>
        </div>
      </div>
    </template>

    <template v-else-if="type === 'manager'">
      <div class="behavior-section">
        <div class="behavior-section__title">Management Style</div>
        <div class="form-row">
          <label>Management Style</label>
          <select :value="form.managementStyle" @change="update('managementStyle', ($event.target as HTMLSelectElement).value)">
            <option value="hands_off">Hands Off</option>
            <option value="balanced">Balanced</option>
            <option value="micromanager">Micromanager</option>
          </select>
        </div>
        <div class="form-row">
          <label>Risk Tolerance</label>
          <select :value="form.riskTolerance" @change="update('riskTolerance', ($event.target as HTMLSelectElement).value)">
            <option value="conservative">Conservative</option>
            <option value="moderate">Moderate</option>
            <option value="aggressive">Aggressive</option>
          </select>
        </div>
        <div class="form-row">
          <label>Diversification</label>
          <select :value="form.diversificationPreference" @change="update('diversificationPreference', ($event.target as HTMLSelectElement).value)">
            <option value="concentrated">Concentrated</option>
            <option value="balanced">Balanced</option>
            <option value="diversified">Diversified</option>
          </select>
        </div>
        <div class="form-row">
          <label>Performance Patience <span class="value-badge">{{ form.performancePatience }}</span></label>
          <input type="range" min="0" max="100" :value="form.performancePatience" @input="update('performancePatience', Number(($event.target as HTMLInputElement).value))" />
        </div>
        <div class="form-row">
          <label>Creation Aggressiveness <span class="value-badge">{{ form.creationAggressiveness }}</span></label>
          <input type="range" min="0" max="100" :value="form.creationAggressiveness" @input="update('creationAggressiveness', Number(($event.target as HTMLInputElement).value))" />
        </div>
        <div class="form-row">
          <label>Rebalance Frequency</label>
          <select :value="form.rebalanceFrequency" @change="update('rebalanceFrequency', ($event.target as HTMLSelectElement).value)">
            <option value="rarely">Rarely</option>
            <option value="sometimes">Sometimes</option>
            <option value="often">Often</option>
          </select>
        </div>
        <div class="form-row">
          <label>Philosophy Bias</label>
          <select :value="form.philosophyBias" @change="update('philosophyBias', ($event.target as HTMLSelectElement).value)">
            <option value="trend_following">Trend Following</option>
            <option value="mean_reversion">Mean Reversion</option>
            <option value="mixed">Mixed</option>
          </select>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.behavior-form { display: flex; flex-direction: column; gap: 20px; }
.behavior-section { border: 1px solid var(--border, #2a2a2a); border-radius: 8px; padding: 16px; }
.behavior-section__title { font-weight: 600; font-size: 13px; color: var(--text-secondary, #888); text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 12px; }
.form-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 6px 0; border-bottom: 1px solid var(--border-subtle, #1a1a1a); }
.form-row:last-child { border-bottom: none; }
.form-row label { font-size: 13px; color: var(--text, #e0e0e0); flex-shrink: 0; display: flex; align-items: center; gap: 8px; }
.form-row select, .form-row input[type="range"] { flex: 1; max-width: 200px; }
.form-row--checkbox { justify-content: flex-start; gap: 12px; }
.value-badge { background: var(--tag-bg, #1e1e1e); border: 1px solid var(--border, #2a2a2a); border-radius: 4px; padding: 1px 6px; font-size: 11px; color: var(--accent, #7c6af7); font-weight: 600; }
</style>
```

**Step 5: Create `apps/web/components/PersonaEditor.vue`**

```vue
<script setup lang="ts">
const props = defineProps<{
  modelValue: string;
  loading?: boolean;
}>();

const emit = defineEmits<{
  'update:modelValue': [v: string];
  save: [v: string];
  reset: [];
}>();

const showPreview = ref(false);
const localValue = ref(props.modelValue);

watch(() => props.modelValue, (v) => { localValue.value = v; });

const charCount = computed(() => localValue.value.length);
const isOverLimit = computed(() => charCount.value > 4000);

function handleInput(e: Event) {
  const v = (e.target as HTMLTextAreaElement).value;
  localValue.value = v;
  emit('update:modelValue', v);
}

// Simple markdown to HTML (no external dep)
function renderMd(md: string): string {
  return md
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^# (.+)$/gm, '<h1>$1</h1>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/^- (.+)$/gm, '<li>$1</li>')
    .replace(/(<li>.*<\/li>)/s, '<ul>$1</ul>')
    .replace(/\n\n/g, '</p><p>')
    .replace(/^(?!<[hul]|<\/[hul]|<p|<\/p)/gm, '')
    .replace(/\n/g, '<br>');
}
</script>

<template>
  <div class="persona-editor">
    <div class="persona-editor__toolbar">
      <div class="persona-editor__warning">
        ⚠️ This markdown is injected directly into the agent's system prompt. Keep it focused on trading behavior.
      </div>
      <div class="persona-editor__actions">
        <button class="btn btn-ghost btn-sm" type="button" @click="showPreview = !showPreview">
          {{ showPreview ? 'Edit' : 'Preview' }}
        </button>
        <button class="btn btn-ghost btn-sm" type="button" :disabled="loading" @click="emit('reset')">
          Reset to default
        </button>
        <button class="btn btn-primary btn-sm" type="button" :disabled="loading || isOverLimit" @click="emit('save', localValue)">
          {{ loading ? 'Saving...' : 'Save Persona' }}
        </button>
      </div>
    </div>

    <div v-if="showPreview" class="persona-editor__preview" v-html="renderMd(localValue)" />
    <textarea
      v-else
      class="persona-editor__textarea"
      :value="localValue"
      placeholder="Write your agent's persona here..."
      @input="handleInput"
    />

    <div class="persona-editor__footer">
      <span :class="isOverLimit ? 'char-count--over' : 'char-count'">{{ charCount }}/4000 characters</span>
    </div>
  </div>
</template>

<style scoped>
.persona-editor { display: flex; flex-direction: column; gap: 8px; }
.persona-editor__toolbar { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; flex-wrap: wrap; }
.persona-editor__warning { font-size: 12px; color: var(--warning, #f5a623); padding: 6px 10px; background: color-mix(in srgb, var(--warning, #f5a623) 10%, transparent); border-radius: 6px; border: 1px solid color-mix(in srgb, var(--warning, #f5a623) 30%, transparent); flex: 1; }
.persona-editor__actions { display: flex; gap: 8px; flex-shrink: 0; }
.persona-editor__textarea { width: 100%; min-height: 300px; font-family: monospace; font-size: 13px; background: var(--card-bg, #111); color: var(--text, #e0e0e0); border: 1px solid var(--border, #2a2a2a); border-radius: 8px; padding: 12px; resize: vertical; box-sizing: border-box; }
.persona-editor__preview { min-height: 300px; padding: 16px; background: var(--card-bg, #111); border: 1px solid var(--border, #2a2a2a); border-radius: 8px; font-size: 13px; line-height: 1.6; }
.persona-editor__footer { text-align: right; }
.char-count { font-size: 12px; color: var(--text-secondary, #888); }
.char-count--over { font-size: 12px; color: var(--danger, #f44336); font-weight: 600; }
</style>
```

**Step 6: Build/type-check web**

```bash
cd apps/web && pnpm nuxi typecheck 2>&1 | head -40
```
Expected: no errors in new components

**Step 7: Commit**

```bash
git add apps/web/components/BehaviorProfileCard.vue apps/web/components/BehaviorProfilePicker.vue apps/web/components/BehaviorSettingsForm.vue apps/web/components/PersonaEditor.vue apps/web/composables/useProfiles.ts
git commit -m "feat: add BehaviorProfileCard, BehaviorProfilePicker, BehaviorSettingsForm, PersonaEditor components"
```

---

## Task 7: Wire Up Agent Create/Edit Flow

**Files:**
- Modify: `apps/web/components/AgentConfigForm.vue`

**Step 1: Read current `AgentConfigForm.vue` fully**

Read the full file content before making edits to understand current structure.

**Step 2: Add profile picker tab and behavior tab to `AgentConfigForm.vue`**

The form needs three tabs: **Config** (existing) | **Behavior** (new) | **Persona** (new).

Add to the form's reactive state:
```typescript
const activeTab = ref<'config' | 'behavior' | 'persona'>('config');
const selectedProfileId = ref<string | null>(null);
const behavior = ref<Record<string, unknown>>({
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
});
const personaMd = ref('');

function onProfileSelected(profile: ProfileItem) {
  selectedProfileId.value = profile.id;
  behavior.value = { ...profile.behaviorConfig };
  // Don't overwrite persona if user has edited it
}
```

Modify `handleSubmit` to include `behavior` in the payload:
```typescript
const payload = {
  ...form,
  behavior: behavior.value,
  profileId: selectedProfileId.value ?? undefined,
};
emit('submit', payload);
```

Add tab UI above the form fields:
```vue
<div class="form-tabs">
  <button type="button" :class="['tab-btn', { active: activeTab === 'config' }]" @click="activeTab = 'config'">Config</button>
  <button type="button" :class="['tab-btn', { active: activeTab === 'behavior' }]" @click="activeTab = 'behavior'">Behavior</button>
  <button type="button" :class="['tab-btn', { active: activeTab === 'persona' }]" @click="activeTab = 'persona'">Persona</button>
</div>

<div v-show="activeTab === 'config'">
  <!-- existing form fields stay here -->
</div>

<div v-show="activeTab === 'behavior'">
  <div style="margin-bottom:16px;">
    <div class="section-label">Choose a Preset Profile</div>
    <BehaviorProfilePicker v-model="selectedProfileId" type="agent" @profile-selected="onProfileSelected" />
  </div>
  <div style="margin-top:20px;">
    <div class="section-label">Fine-tune Behavior</div>
    <BehaviorSettingsForm v-model="behavior" type="agent" />
  </div>
</div>

<div v-show="activeTab === 'persona'">
  <PersonaEditor v-model="personaMd" />
</div>
```

**Step 3: Update `CreateAgentPayload` type in `useAgents.ts` composable**

Read `apps/web/composables/useAgents.ts` and add:
```typescript
behavior?: Record<string, unknown>;
profileId?: string;
```
to the `CreateAgentPayload` interface.

**Step 4: Update `ManagerConfigForm.vue` similarly**

Same pattern — add `activeTab`, `behavior`, `selectedProfileId`, tabs UI, `BehaviorProfilePicker` (type="manager"), `BehaviorSettingsForm` (type="manager").

**Step 5: Build check**

```bash
cd apps/web && pnpm nuxi typecheck 2>&1 | head -40
```

**Step 6: Commit**

```bash
git add apps/web/components/AgentConfigForm.vue apps/web/components/ManagerConfigForm.vue apps/web/composables/useAgents.ts
git commit -m "feat: add Behavior and Persona tabs to agent/manager config forms"
```

---

## Task 8: Agent & Manager Detail Pages — Behavior and Persona Tabs

**Files:**
- Modify: `apps/web/pages/agents/[id].vue`
- Modify: `apps/web/pages/managers/[id]/index.vue`

**Step 1: Read full `apps/web/pages/agents/[id].vue`**

Understand the existing tab structure (currently: trades | decisions | performance).

**Step 2: Add Behavior and Persona tabs to agent detail page**

Add to the tab list:
```vue
<button :class="['tab', { active: tab === 'behavior' }]" @click="tab = 'behavior'">Behavior</button>
<button :class="['tab', { active: tab === 'persona' }]" @click="tab = 'persona'">Persona</button>
```

Add state and data loading:
```typescript
const { getAgentPersona, updateAgentPersona, resetAgentPersona } = useProfiles();
const personaMd = ref('');
const personaLoading = ref(false);
const personaSaving = ref(false);

onMounted(async () => {
  // ... existing loads ...
  const personaData = await getAgentPersona(id.value);
  personaMd.value = personaData.personaMd ?? '';
});

async function savePersona(md: string) {
  personaSaving.value = true;
  try {
    await updateAgentPersona(id.value, md);
    personaMd.value = md;
  } finally {
    personaSaving.value = false;
  }
}

async function doResetPersona() {
  personaSaving.value = true;
  try {
    const res = await resetAgentPersona(id.value);
    personaMd.value = res.personaMd;
  } finally {
    personaSaving.value = false;
  }
}
```

Add tab content panels:
```vue
<!-- Behavior Tab -->
<div v-show="tab === 'behavior'">
  <div v-if="agent?.config?.behavior">
    <BehaviorSettingsForm :model-value="agent.config.behavior" type="agent" @update:model-value="() => {}" />
    <div style="margin-top:12px;">
      <NuxtLink :to="`/agents/${agent.id}/edit`" class="btn btn-primary">Edit Behavior</NuxtLink>
    </div>
  </div>
  <div v-else style="color:var(--text-secondary,#888);padding:24px;text-align:center;">
    No behavior config set. Edit the agent to add a behavior profile.
  </div>
</div>

<!-- Persona Tab -->
<div v-show="tab === 'persona'">
  <PersonaEditor
    v-model="personaMd"
    :loading="personaSaving"
    @save="savePersona"
    @reset="doResetPersona"
  />
</div>
```

**Step 3: Add Behavior and Persona tabs to manager detail page**

Same pattern as agent detail page but using `getManagerPersona`, `updateManagerPersona`, `resetManagerPersona`, and `type="manager"` for `BehaviorSettingsForm`.

**Step 4: Build check**

```bash
cd apps/web && pnpm nuxi typecheck 2>&1 | head -40
```

**Step 5: Commit**

```bash
git add apps/web/pages/agents/[id].vue apps/web/pages/managers/[id]/index.vue
git commit -m "feat: add Behavior and Persona tabs to agent/manager detail pages"
```

---

## Task 9: Full Build Verification & Cleanup

**Step 1: Build shared package**

```bash
pnpm --filter @dex-agents/shared build
```
Expected: success, no errors

**Step 2: Type-check API**

```bash
cd apps/api && pnpm tsc --noEmit
```
Expected: no errors

**Step 3: Type-check frontend**

```bash
cd apps/web && pnpm nuxi typecheck 2>&1 | head -60
```
Expected: no errors

**Step 4: Test API locally**

```bash
cd apps/api && npx wrangler dev
```

In another terminal, test key endpoints:
```bash
# List profiles
curl http://localhost:8787/api/profiles

# List agent profiles only
curl http://localhost:8787/api/profiles?type=agent

# Get specific preset
curl http://localhost:8787/api/profiles/the_bot
```

Expected: Returns profile list with 10 agent presets and 4 manager presets

**Step 5: Final cleanup commit**

```bash
git add -A
git commit -m "feat: complete agent/manager personality system with behavior profiles and persona editor"
```

---

## Summary of All Files Changed

### New Files
- `packages/shared/src/profiles/agent-profiles.ts` — 10 preset agent profiles
- `packages/shared/src/profiles/manager-profiles.ts` — 4 preset manager profiles
- `packages/shared/src/profiles/templates.ts` — persona markdown templates per profile
- `apps/api/src/db/migrations/0004_behavior_profiles.sql` — schema migration
- `apps/api/src/routes/profiles.ts` — profiles CRUD API
- `apps/web/components/BehaviorProfileCard.vue`
- `apps/web/components/BehaviorProfilePicker.vue`
- `apps/web/components/BehaviorSettingsForm.vue`
- `apps/web/components/PersonaEditor.vue`
- `apps/web/composables/useProfiles.ts`

### Modified Files
- `packages/shared/src/validation.ts` — add behavior Zod schemas
- `packages/shared/src/index.ts` — export profiles
- `apps/api/src/db/schema.ts` — add new columns + behaviorProfiles table
- `apps/api/src/agents/prompts.ts` — inject behavior + persona into prompts
- `apps/api/src/agents/agent-loop.ts` — pass behavior/persona to prompts
- `apps/api/src/routes/agents.ts` — add persona routes
- `apps/api/src/routes/managers.ts` — add persona routes
- `apps/api/src/index.ts` — register profiles route
- `apps/web/components/AgentConfigForm.vue` — add behavior/persona tabs
- `apps/web/components/ManagerConfigForm.vue` — add behavior/persona tabs
- `apps/web/pages/agents/[id].vue` — add behavior/persona tabs
- `apps/web/pages/managers/[id]/index.vue` — add behavior/persona tabs
- `apps/web/composables/useAgents.ts` — add behavior fields to payload type
