# Task: Add Agent & Manager Behavior Settings, Profiles, and Editable Persona Markdown

## Context

This is the Heppy Market project — a DEX paper trading platform where AI agents trade on Base chain using OpenRouter LLMs. See the existing project structure and README for full context.

Currently agents have trading config (balance, pairs, intervals, risk params) but **no personality/behavior customization**. We need to add a full behavior system so users can control *how* agents think and act, not just *what* they trade.

---

## What to Build

### 1. Agent Behavior Settings

Add these configurable behavior dimensions to agent config (store in the existing `config` JSON column on the `agents` table):

#### Risk Personality
- **`riskAppetite`**: `conservative` | `moderate` | `aggressive` | `degen` — How much risk the agent tolerates
- **`fomoProne`**: `0-100` — How likely to chase pumps / fear missing out
- **`panicSellThreshold`**: `0-100` — How quickly it panic sells on dips
- **`contrarian`**: `0-100` — Tendency to go against market sentiment (0 = follows crowd, 100 = always contrarian)

#### Decision Style
- **`analysisDepth`**: `quick` | `balanced` | `thorough` — How much data it considers before deciding
- **`decisionSpeed`**: `impulsive` | `measured` | `patient` — How quickly it acts on signals
- **`confidenceThreshold`**: `0-100` — Minimum confidence to execute a trade (low = trades on weak signals)
- **`overthinker`**: `boolean` — If true, agent sometimes talks itself out of good trades (realistic human flaw)

#### Trading Philosophy
- **`style`**: `scalper` | `swing` | `position` | `hybrid` — Preferred holding period approach
- **`preferredConditions`**: `trending` | `ranging` | `volatile` | `any` — Market conditions it performs best in
- **`entryPreference`**: `breakout` | `pullback` | `dip_buy` | `momentum` — How it prefers to enter positions
- **`exitStrategy`**: `tight_stops` | `trailing` | `time_based` | `signal_based` — How it manages exits
- **`averageDown`**: `boolean` — Whether it will add to losing positions

#### Communication & Logging
- **`verbosity`**: `minimal` | `normal` | `detailed` | `stream_of_consciousness` — How much reasoning it logs
- **`personality`**: `professional` | `casual` | `meme_lord` | `academic` | `custom` — Tone of decision logs
- **`emotionalAwareness`**: `boolean` — Whether it acknowledges emotional factors ("I know this looks scary but...")

#### Market Outlook
- **`defaultBias`**: `bullish` | `bearish` | `neutral` — Starting sentiment bias
- **`adaptability`**: `0-100` — How quickly it changes its bias based on new data
- **`memoryWeight`**: `short` | `medium` | `long` — How much past trades influence current decisions

### 2. Manager Behavior Settings

Add these to manager config:

- **`managementStyle`**: `hands_off` | `balanced` | `micromanager` — How often it intervenes with agents
- **`riskTolerance`**: `conservative` | `moderate` | `aggressive` — Portfolio-level risk approach
- **`diversificationPreference`**: `concentrated` | `balanced` | `diversified` — How it spreads across agents/pairs
- **`performancePatience`**: `0-100` — How long it waits before killing underperforming agents (0 = kills fast)
- **`creationAggressiveness`**: `0-100` — How eagerly it spins up new agents on opportunities
- **`rebalanceFrequency`**: `rarely` | `sometimes` | `often` — How often it adjusts agent configs
- **`philosophyBias`**: `trend_following` | `mean_reversion` | `mixed` — Overall portfolio strategy lean

### 3. Behavior Profiles (Presets)

Create a profile system with built-in presets and user-custom profiles.

#### Built-in Agent Profiles

Store in `packages/shared/src/profiles/agent-profiles.ts`:

```typescript
// Example structure — implement all profiles listed below
export interface BehaviorProfile {
  id: string
  name: string
  description: string
  emoji: string
  category: 'preset' | 'custom'
  behavior: AgentBehaviorConfig // all the fields from section 1
  suggestedConfig?: Partial<AgentTradingConfig> // optional trading config overrides
}
```

**Preset profiles to create:**

| Profile | Emoji | Description | Key Traits |
|---|---|---|---|
| **Diamond Hands** | 💎 | Never sells early, high conviction | patient, low panicSell, position style, long memory |
| **Degen Ape** | 🦍 | YOLO momentum trader | aggressive, high FOMO, impulsive, scalper, meme_lord personality |
| **The Professor** | 🎓 | Academic, data-driven, cautious | thorough analysis, high confidence threshold, academic personality, conservative |
| **Whale Watcher** | 🐋 | Follows smart money and big moves | moderate risk, breakout entry, trending conditions, detailed logging |
| **Scared Cat** | 🐱 | Extremely risk averse, tight stops | conservative, high panicSell, tight_stops, minimal positions |
| **Contrarian Chad** | 🔄 | Always bets against the crowd | high contrarian, pullback/dip_buy entry, bearish default bias |
| **The Bot** | 🤖 | Pure signals, zero emotion | strict analysis, no emotional awareness, signal_based exits, professional |
| **Momentum Surfer** | 🏄 | Rides trends until they break | aggressive on trends, trailing stops, high adaptability, momentum entry |
| **The Sniper** | 🎯 | Very few trades, very high conviction | patient, very high confidence threshold, thorough, position style |
| **Paper Hands** | 🧻 | Sells at the first sign of trouble | high panicSell, impulsive, tight stops, short memory |

#### Built-in Manager Profiles

| Profile | Emoji | Description |
|---|---|---|
| **Venture Mode** | 🚀 | Aggressive creation, high tolerance, diversified |
| **Risk Officer** | 🛡️ | Conservative, quick to kill losers, balanced |
| **Passive Index** | 📊 | Hands off, diversified, rarely rebalances |
| **Active Hedge** | ⚖️ | Micromanager, frequent rebalance, mixed philosophy |

#### Custom Profiles

- Users can save current agent/manager config as a named custom profile
- Store custom profiles in a new `behavior_profiles` D1 table:

```sql
CREATE TABLE behavior_profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  emoji TEXT DEFAULT '🤖',
  description TEXT,
  type TEXT NOT NULL CHECK (type IN ('agent', 'manager')),
  behavior_config TEXT NOT NULL, -- JSON
  suggested_trading_config TEXT, -- JSON, optional
  is_preset INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
```

### 4. Editable Persona Markdown Files

This is the key feature — each agent and manager gets an editable markdown "persona file" that is injected into its system prompt. This gives users full creative control over agent behavior beyond structured settings.

#### Storage

Add a `persona_md` TEXT column to both `agents` and `managers` tables (or store in a separate `personas` table if cleaner).

#### Default Templates

Generate a default persona markdown when an agent/manager is created, based on the selected profile. Store templates in `packages/shared/src/profiles/templates/`.

Example default for "Degen Ape" agent:

```markdown
# Trading Persona: Degen Ape 🦍

## Core Identity
You are an aggressive, high-conviction degen trader. You live for the pump and you're not afraid of drawdowns. Your motto: "Fortune favors the bold."

## Trading Rules
- Always look for momentum plays and volume spikes
- Don't overthink — if it's pumping, you're in
- Cut losers fast but let winners ride hard
- You love memecoins and new token launches
- Volume is your best friend — no volume, no trade

## Communication Style
- Keep it casual and fun
- Use crypto slang freely (LFG, ngmi, wagmi, ape in, etc.)
- Express excitement about good setups
- Be honest when you get rekt — own it

## Risk Approach
- You're comfortable with 3-5% position sizes
- You'll size up on high-conviction plays
- You accept that some trades will be -20% but your winners should be bigger
- Never go all-in on a single position (ok maybe sometimes)

## Market Analysis
- Focus on price action and volume over fundamentals
- Watch for breakouts above resistance
- Monitor social sentiment and hype cycles
- If everyone's scared, you're probably buying
```

Example default for "The Professor" agent:

```markdown
# Trading Persona: The Professor 🎓

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
- Risk/reward minimum 1:2 before considering entry
- Scale into positions rather than full entry

## Market Analysis
- Multi-timeframe analysis is mandatory
- Weight technical indicators: RSI divergence, MACD crossovers, EMA trends
- Consider market structure (higher highs/lows, support/resistance)
- Factor in overall market conditions (BTC dominance, total market cap trends)
```

#### Frontend Editor

- Add a markdown editor component (use a simple textarea with preview, or integrate a lightweight md editor like `@bytemd/vue-next` or just `textarea` + `marked` for preview)
- Show on the agent/manager detail page as a tab: **Config | Behavior | Persona**
- Include a "Reset to profile default" button
- Show a warning: "This markdown is injected directly into the agent's system prompt. Be creative but keep it focused on trading behavior."

#### Prompt Integration

In `apps/api/src/agents/prompts.ts`, modify the system prompt builder to inject the persona markdown:

```typescript
function buildSystemPrompt(agent: Agent): string {
  const base = getAutonomyPrompt(agent.config.autonomyLevel)
  const behavior = buildBehaviorSection(agent.config.behavior)
  const persona = agent.persona_md || getDefaultPersona(agent.config.behavior)
  
  return `${base}\n\n## Your Behavior Profile\n${behavior}\n\n## Your Persona\n${persona}`
}
```

### 5. Frontend Changes

#### Agent Create/Edit Flow

Update `AgentConfigForm.vue`:
1. Add a **"Choose Profile"** step with visual profile cards (emoji + name + description + key traits)
2. Selecting a profile pre-fills both behavior settings AND suggested trading config
3. Add a **"Behavior"** tab/section with sliders and dropdowns for all behavior settings
4. Add a **"Persona"** tab with the markdown editor
5. Allow switching profiles — warn if current config has unsaved changes

#### Manager Create/Edit Flow

Update `ManagerConfigForm.vue` similarly with manager profiles and behavior settings.

#### Agent Detail Page (`agents/[id].vue`)

Add tabs: **Overview | Trades | Decisions | Behavior | Persona**
- **Behavior tab**: Read-only view of behavior settings with "Edit" button
- **Persona tab**: Markdown editor with live preview, save button, reset to default

#### New Components Needed

- `BehaviorProfileCard.vue` — Displays a profile with emoji, name, description, traits summary
- `BehaviorProfilePicker.vue` — Grid/list of profile cards for selection
- `BehaviorSettingsForm.vue` — Sliders/dropdowns for all behavior dimensions
- `PersonaEditor.vue` — Markdown textarea with preview toggle
- `ProfileSaveModal.vue` — Save current config as custom profile (name, emoji, description)

### 6. API Changes

#### New Routes

```
GET    /api/profiles                    # List all profiles (preset + custom)
POST   /api/profiles                    # Create custom profile
GET    /api/profiles/:id                # Get profile
PATCH  /api/profiles/:id                # Update custom profile
DELETE /api/profiles/:id                # Delete custom profile (preset = 403)

GET    /api/agents/:id/persona          # Get agent persona markdown
PUT    /api/agents/:id/persona          # Update agent persona markdown
POST   /api/agents/:id/persona/reset    # Reset to profile default

GET    /api/managers/:id/persona        # Get manager persona markdown
PUT    /api/managers/:id/persona        # Update manager persona markdown
POST   /api/managers/:id/persona/reset  # Reset to profile default
```

#### Schema Changes

```sql
-- Add to agents table
ALTER TABLE agents ADD COLUMN persona_md TEXT;
ALTER TABLE agents ADD COLUMN profile_id TEXT;

-- Add to managers table  
ALTER TABLE managers ADD COLUMN persona_md TEXT;
ALTER TABLE managers ADD COLUMN profile_id TEXT;

-- New table
CREATE TABLE behavior_profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  emoji TEXT DEFAULT '🤖',
  description TEXT,
  type TEXT NOT NULL CHECK (type IN ('agent', 'manager')),
  behavior_config TEXT NOT NULL,
  suggested_trading_config TEXT,
  is_preset INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
```

### 7. Shared Types

Add to `packages/shared/src/types/`:

```typescript
// behavior.ts
export interface AgentBehaviorConfig {
  // Risk Personality
  riskAppetite: 'conservative' | 'moderate' | 'aggressive' | 'degen'
  fomoProne: number // 0-100
  panicSellThreshold: number // 0-100
  contrarian: number // 0-100
  
  // Decision Style
  analysisDepth: 'quick' | 'balanced' | 'thorough'
  decisionSpeed: 'impulsive' | 'measured' | 'patient'
  confidenceThreshold: number // 0-100
  overthinker: boolean
  
  // Trading Philosophy
  style: 'scalper' | 'swing' | 'position' | 'hybrid'
  preferredConditions: 'trending' | 'ranging' | 'volatile' | 'any'
  entryPreference: 'breakout' | 'pullback' | 'dip_buy' | 'momentum'
  exitStrategy: 'tight_stops' | 'trailing' | 'time_based' | 'signal_based'
  averageDown: boolean
  
  // Communication
  verbosity: 'minimal' | 'normal' | 'detailed' | 'stream_of_consciousness'
  personality: 'professional' | 'casual' | 'meme_lord' | 'academic' | 'custom'
  emotionalAwareness: boolean
  
  // Market Outlook
  defaultBias: 'bullish' | 'bearish' | 'neutral'
  adaptability: number // 0-100
  memoryWeight: 'short' | 'medium' | 'long'
}

export interface ManagerBehaviorConfig {
  managementStyle: 'hands_off' | 'balanced' | 'micromanager'
  riskTolerance: 'conservative' | 'moderate' | 'aggressive'
  diversificationPreference: 'concentrated' | 'balanced' | 'diversified'
  performancePatience: number // 0-100
  creationAggressiveness: number // 0-100
  rebalanceFrequency: 'rarely' | 'sometimes' | 'often'
  philosophyBias: 'trend_following' | 'mean_reversion' | 'mixed'
}
```

Add Zod schemas for validation in `packages/shared/src/schemas/`.

---

## Implementation Order

1. **Shared types + Zod schemas** for behavior configs
2. **Profile definitions** (preset profiles with all behavior values + persona templates)
3. **DB migrations** (new columns + profiles table)
4. **API routes** for profiles and persona CRUD
5. **Prompt integration** — inject behavior config + persona_md into system prompts
6. **Frontend components** — ProfilePicker, BehaviorSettingsForm, PersonaEditor
7. **Wire up create/edit flows** — agents and managers
8. **Agent/Manager detail pages** — add Behavior and Persona tabs
9. **Profile save/load** — custom profile creation from current config

---

## Important Notes

- All behavior settings should have sensible defaults (use "The Bot" profile defaults as baseline)
- Persona markdown has a max length of 4000 characters (to not blow up context windows)
- The persona markdown is **additive** to the structured behavior config — it adds flavor/nuance, while the structured config drives actual parameter-level decisions
- When behavior config conflicts with persona markdown, structured config wins (the system prompt should make this clear to the LLM)
- Preset profiles are read-only — users must "duplicate" to customize
- Include a seed migration that inserts all preset profiles into `behavior_profiles`
- Keep the existing agent config structure backward compatible — behavior is a new nested object, agents without it get default "Bot" profile behavior