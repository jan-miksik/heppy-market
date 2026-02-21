# DEX Paper Trading Platform — Coding Agent Prompts

> Prompts organized by priority and dependency order. Each prompt is self-contained and ready to hand to a coding agent.

---

## 1. Quick Fixes & Polish

### 1.1 — Latency Display: Milliseconds → Seconds

**Context:** The app currently displays latency values in milliseconds. Users find seconds more readable.

**Task:**
- Find all locations in the codebase where latency is displayed in milliseconds (ms)
- Convert the display to seconds (s) with appropriate decimal precision (e.g., `1250ms` → `1.25s`)
- If latency is under 1 second, show 2 decimal places (e.g., `0.12s`). If 1s or above, show 1 decimal place (e.g., `3.2s`)
- Update any labels, tooltips, and column headers from "ms" to "s"
- Ensure internal calculations still use milliseconds — only the display layer changes

---

### 1.2 — Default Analysis Timeframe: 1 Hour

**Context:** The default time window for analysis/charting needs to be set to 1 hour.

**Task:**
- Locate the default time range configuration for the analysis/charting views
- Change the default from whatever it currently is to `1 hour`
- Ensure the time selector UI reflects this default on load
- Verify that data fetching respects this new default (query params, API calls, etc.)

---

### 1.3 — Dashboard Loading State

**Context:** When navigating to the dashboard, users see a brief flash of the empty state before data loads. This feels broken.

**Task:**
- Add a loading skeleton or spinner to the dashboard that displays while data is being fetched
- The loader should appear immediately on route entry, before any data arrives
- Use skeleton loaders that match the layout of the actual dashboard content (cards, charts, tables) — not just a generic spinner
- Only show the empty state if data has finished loading AND there is genuinely no data
- Ensure no layout shift when the real content replaces the skeleton

---

### 1.4 — Add Beta Badge

**Context:** The app is in beta and this should be clearly communicated to users.

**Task:**
- Add a "Beta" badge/tag visible in the app header or next to the app logo
- Style it as a small pill/badge (e.g., a subtle colored tag)
- It should be visible on all pages
- Make it easy to remove later — use a feature flag or a single config constant like `IS_BETA = true`

---

### 1.5 — Add Temperature Parameter to Agent Setup

**Context:** When creating an agent, users configure which LLM to use. They should also be able to set the LLM temperature.

**Task:**
- Add a "Temperature" field to the agent creation/setup form
- Use a slider input with range `0.0` to `2.0`, step `0.1`, default `0.7`
- Include a brief tooltip/helper text explaining what temperature does (e.g., "Lower = more deterministic, Higher = more creative")
- Persist this value in the agent configuration
- Pass the temperature parameter to the LLM API calls when the agent runs
- Show the temperature value in the agent detail/summary view

---

### 1.6 — Enable Editing of Existing Agents

**Context:** Once an agent is created, users currently cannot edit its configuration. They should be able to.

**Task:**
- Add an "Edit" button/action to each agent's detail view and/or the agent list
- Clicking edit should open the same form used for creation, pre-populated with the agent's current configuration
- All fields that are available during creation should be editable (name, LLM, temperature, trading pair, strategy parameters, etc.)
- Implement proper form validation on save
- If the agent is currently running, either: (a) pause it before applying changes, or (b) warn the user that changes will take effect on the next trading cycle — choose whichever is simpler and document the behavior
- Add an update API endpoint or mutation if one doesn't exist

---

## 2. Authentication

### 2.1 — Implement Web3 Authentication (Reown + wagmi)

**Context:** The app currently has no authentication. We need wallet-based auth to identify users and prepare for future paid features.

**Task:**
- Integrate [Reown](https://reown.com/) (formerly WalletConnect) AppKit + wagmi for wallet connection
- Support the following flows:
  - Connect wallet (MetaMask, WalletConnect, Coinbase Wallet at minimum)
  - Sign-In with Ethereum (SIWE) to create an authenticated session
  - Disconnect / sign out
- Create a session management layer:
  - Store session server-side or in a secure cookie/JWT after SIWE verification
  - Auto-reconnect on page reload if session is still valid
- Add an auth guard: unauthenticated users should be redirected to a connect/login page
- Display the connected wallet address (truncated) and a disconnect button in the app header
- Ensure all agent data is scoped to the authenticated user's wallet address
- **Tech notes:** The app uses Nuxt/Vue. Use `@reown/appkit` and `@wagmi/vue` or their equivalents. Set up a Reown project ID.

---

## 3. Agent Visibility & Public Square

### 3.1 — Public/Private Agent Toggle

**Context:** Agents should be private by default. Users should be able to optionally make them public.

**Task:**
- Add a "Visibility" toggle to the agent creation and edit forms
- Options: `Private` (default) and `Public`
- Private agents are only visible to their creator
- Public agents are visible on the Public Square (see next prompt)
- Store this as a field on the agent model
- Add appropriate API-level access control: queries for public agents should not expose private ones

---

### 3.2 — Public Square: Shared Agent Discovery

**Context:** We want a community page where users can browse public agents shared by others.

**Task:**
- Create a new "Public Square" page/route (e.g., `/explore` or `/square`)
- Display all public agents in a card grid or list view
- Each agent card should show: agent name, creator (wallet address, truncated), LLM used, trading pair, strategy type, total P&L or ROI if available, creation date
- **Sorting options:** newest first, oldest first, best ROI, highest starting amount, alphabetical
- **Filtering options:** by LLM model, by trading pair, by profit/loss status (profitable / unprofitable), by date range
- Add a search bar for filtering by agent name or creator address
- Clicking an agent card should open a read-only detail view (users cannot edit others' agents)
- Consider adding: a "copy agent" button that lets a user clone a public agent's configuration into their own new agent
- Add pagination or infinite scroll for the agent list

---

## 4. Agent Manager (Meta-Agent)

### 4.1 — Create Agent Manager System

**Context:** Beyond individual trading agents, we want a "manager" — a meta-agent that creates, monitors, evaluates, and optimizes trading agents autonomously.

**Task:**
Build an Agent Manager system with the following capabilities:

**Core Loop:**
- The manager runs on a configurable decision loop (e.g., every 1 hour, 4 hours, 24 hours)
- Each cycle, it evaluates all trading agents under its control and decides what actions to take

**Agent Lifecycle Management:**
- Create new trading agents with specific configurations (pair, strategy, LLM, temperature, starting amount)
- Pause, resume, or terminate underperforming agents
- Modify any parameter of a trading agent (strategy, temperature, position sizing, risk limits, etc.)

**Performance Evaluation:**
- Track each agent's P&L, win rate, Sharpe ratio, max drawdown, and trade frequency
- Compare agent performance against benchmarks (e.g., buy-and-hold, market average)
- Identify which parameter changes led to improvements vs. degradation

**Memory & Learning:**
- The manager maintains a persistent memory/journal of:
  - Decisions made and their outcomes
  - Hypotheses tested (e.g., "lower temperature improves consistency")
  - Parameter configurations that worked well vs. poorly for specific market conditions
- Periodically re-evaluate past assumptions: what worked last month may not work now
- Use structured memory (not just chat history) — consider a JSON log or database table

**Research Delegation:**
- The manager can spawn "research agents" — short-lived agents that gather market data, analyze trends, or backtest strategies
- Research agent findings feed into the manager's decision-making

**Suggested additional capabilities** (implement if feasible):
- **Risk management:** Set portfolio-level risk limits across all managed agents (e.g., max total drawdown, max correlated positions)
- **Market regime detection:** Identify whether the market is trending, ranging, or volatile, and adjust agent strategies accordingly
- **A/B testing:** Run two agents with identical setups except one parameter to isolate what works
- **Reporting:** Generate periodic summaries of portfolio performance, decisions made, and rationale
- **Alerting:** Notify the user (in-app) when significant decisions are made or when portfolio-level thresholds are breached

**UI:**
- Create a Manager creation form (similar to agent creation) with: name, decision loop interval, risk parameters, LLM for the manager itself, temperature
- Manager dashboard showing: all managed agents, recent decisions, performance overview, memory log
- Ability to pause/resume/delete the manager

---

## 5. Design & Theming

### 5.1 — Design Overhaul + Theme System

**Context:** The app needs a visual refresh and support for multiple themes.

**Task:**

**Theme System:**
- Implement a theme switcher in user settings
- Themes should control: color palette, background, text colors, border styles, card styles, and accent colors
- Use CSS custom properties (variables) for all themeable values
- Persist the user's theme choice (localStorage or user profile)

**Create the following themes:**

1. **Default / Dark Terminal** — Dark background, green/cyan accents, monospace data displays. Think Bloomberg terminal meets modern UI.
2. **Light Clean** — White/light gray background, blue accents, professional and minimal. Good for daytime use.
3. **Midnight Blue** — Deep navy background, gold/amber accents, subtle gradients. Premium feel.
4. **Cyberpunk** — Dark with neon pink/purple/electric blue accents, glowing borders, aggressive styling. Fun and bold.
5. **Paper** — Warm off-white background, serif typography for headers, minimal borders. Calm and readable.

**Additional requirements:**
- Ensure sufficient contrast ratios (WCAG AA) in all themes
- Theme transition should be smooth (CSS transition on color changes)
- All existing components must look good in every theme — audit and fix any hardcoded colors

---

## 6. Testing

### 6.1 — Write Comprehensive Tests (Target: 80%+ Coverage)

**Context:** The app currently lacks test coverage. We need unit, integration, and component tests.

**Task:**

**Setup:**
- Configure the test framework if not already set up (Vitest for unit/integration, Vue Test Utils for components, Playwright or Cypress for e2e if time permits)
- Set up coverage reporting (e.g., `vitest --coverage`)

**What to test:**

- **Unit tests:**
  - Trading logic: P&L calculations, position sizing, signal generation
  - Agent configuration validation
  - Utility functions (formatting, time conversions, etc.)
  - State management (Pinia stores if used)

- **Component tests:**
  - Agent creation form: validation, default values, submission
  - Agent list/cards: rendering, sorting, filtering
  - Dashboard: loading states, empty states, data display
  - Theme switcher: theme application, persistence

- **Integration tests:**
  - Agent CRUD flow: create → view → edit → delete
  - Authentication flow: connect wallet → sign in → access protected routes → disconnect
  - Public Square: visibility toggle → agent appears/disappears from public view
  - Agent Manager: create manager → verify it creates agents → verify evaluation loop

- **Edge cases:**
  - Empty states (no agents, no data)
  - Error states (API failures, wallet disconnection mid-session)
  - Rapid navigation (route changes during loading)

**Validation step:**
After writing all tests, review them and answer:
- Are we testing actual behavior or just implementation details?
- Do the tests catch real bugs or are they tautological?
- Are there critical paths with no coverage?
Write a brief `TEST_REVIEW.md` summarizing coverage gaps and test quality assessment.

---

## 7. Trading Pairs Expansion

### 7.1 — Add More Trading Pairs with Selection Modal

**Context:** The app currently supports a limited set of trading pairs. We should offer the top pairs by volume and market cap.

**Task:**

**Data:**
- Fetch available trading pairs from a DEX aggregator or price API (e.g., CoinGecko, DeFi Llama, or the DEX's own API)
- Prioritize pairs with the highest 24h trading volume and market cap
- Include at minimum the top 30-50 pairs

**Selection Modal:**
- When creating or editing an agent, the trading pair field should open a modal for pair selection
- Modal content — a searchable, sortable table with columns:
  - **Pair name** (e.g., ETH/USDC)
  - **24h Volume** (formatted, e.g., $1.2B)
  - **Market Cap** (formatted)
  - **1-Day Price Change** (% with green/red coloring)
  - **7-Day Price Change** (% with green/red coloring)
- Add a search input at the top to filter by pair name or token symbol
- Default sort: by 24h volume descending
- Allow sorting by clicking column headers
- Clicking a row selects the pair and closes the modal
- Show a subtle sparkline or mini chart for 7-day price if feasible (nice-to-have)

**Refresh:**
- Cache the pair data with a reasonable TTL (e.g., 5 minutes)
- Show a "last updated" timestamp in the modal footer