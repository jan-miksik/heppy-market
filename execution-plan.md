# Execution Plan for Claude Code

> This file tells you HOW to run task2.md. Read task2.md for WHAT to build.

## How to Use

Run each phase as a separate Claude Code session. Copy the prompt for each phase, run it, review the diff, commit, then move to the next phase. This keeps context fresh and lets you catch issues early.

---

## Phase A — Quick Fixes (tasks 1.1–1.4)

```
Read task2.md sections 1.1 through 1.4. Implement all four in this order:

1.1 — Change latency display from ms to seconds across the entire app
1.2 — Set default analysis timeframe to 1 hour
1.3 — Add skeleton loaders to the dashboard (replace empty state flash)
1.4 — Add a beta badge in the app header

For each change:
- Search the full codebase before editing to find ALL occurrences
- Do not ask me questions — make reasonable decisions and document them in commit messages
- After all four are done, run the dev server build to verify nothing is broken

Commit each fix separately with a descriptive message.
```

---

## Phase B — Agent Config (tasks 1.5–1.6)

```
Read task2.md sections 1.5 and 1.6. Implement both:

1.5 — Add temperature parameter (0.0–2.0, default 0.7, slider) to agent setup.
It must be:
- In the creation form (AgentConfigForm.vue)
- Persisted in the agent config JSON in D1
- Passed to the LLM call in llm-router.ts
- Visible in the agent detail view

1.6 — Make existing agents editable.
- Add edit button to agent detail and agent list
- Reuse AgentConfigForm.vue, pre-populated with current config
- Add PATCH /api/agents/:id handler if not complete
- If agent is running, apply changes on next cycle (don't pause)

Use the existing patterns in the codebase. Match the current code style exactly. Do not introduce new dependencies without justification. Do not ask me questions. Commit each task separately.
```

---

## Phase C — Authentication

```
Read task2.md section 2.1. Implement Web3 authentication using Reown AppKit + wagmi.

Before writing code, examine the existing codebase structure:
- apps/web/ for the Nuxt frontend
- apps/api/ for the Hono backend
- packages/shared/ for shared types

Implementation plan (execute in this order):

1. Install dependencies: @reown/appkit, @wagmi/vue (or appkit-adapter-wagmi), viem, siwe
2. Backend: Add SIWE verification endpoint (POST /api/auth/verify) that:
   - Verifies the signed SIWE message
   - Creates a session (use a signed cookie or simple JWT — keep it simple)
   - Returns the session token
3. Backend: Add auth middleware to Hono that:
   - Checks session on all /api/agents/* and /api/trades/* routes
   - Passes through on /api/health, /api/auth/*, /api/pairs/*
   - Returns 401 with generic error message (no internal details)
4. Backend: Scope all agent queries to the authenticated wallet address
   - Add owner_address column to agents table if not present
   - Filter all agent CRUD by owner_address
5. Frontend: Create a Reown/wagmi config with Base chain
6. Frontend: Add connect wallet button in the header
7. Frontend: Add a /login or /connect page for unauthenticated users
8. Frontend: Add auth guard middleware — redirect to connect page if no session
9. Frontend: Show truncated wallet address + disconnect button when connected

Get a Reown project ID from https://cloud.reown.com — for now use a placeholder string "REOWN_PROJECT_ID" and leave a comment that it needs to be replaced.

Do not implement key rotation, JWKS, or replay protection — those are not needed at this stage.
Commit logical chunks (backend auth, frontend auth, scope agents to wallet).
```

---

## Phase D — Public/Private + Public Square (tasks 3.1–3.2)

```
Read task2.md sections 3.1 and 3.2. Implement both.

3.1 — Add visibility field to agents:
- Add 'visibility' column to agents table ('private' default, 'public')
- Add toggle to AgentConfigForm.vue
- Filter: users only see own agents + public agents from others
- API must enforce: cannot edit/delete/start/stop another user's agent

3.2 — Build the Public Square page:
- New route: /explore
- Display public agents in a card grid
- Each card: agent name, creator wallet (truncated), LLM, pair, ROI, created date
- Sorting: newest, best ROI, highest balance
- Filtering: by LLM, by pair, profitable/unprofitable
- Search by agent name
- "Clone agent" button that copies config into a new agent for the current user
- Pagination (start with simple offset-based, 20 per page)

Use the existing component patterns. Match the current design system. Do not ask questions. Commit each feature separately.
```

---

## Phase E — Trading Pairs Modal (task 7.1)

```
Read task2.md section 7.1. Replace the current pair picker with a full selection modal.

1. Fetch top pairs by volume from DexScreener API (Base chain)
   - Cache results in KV with 5min TTL (use existing KV cache pattern from dex-data.ts)
   - Include: pair name, 24h volume, market cap, 1d change %, 7d change %

2. Build modal component (PairSelectionModal.vue):
   - Searchable table with columns: Pair, Volume, Market Cap, 1D%, 7D%
   - Color 1D% and 7D% green/red based on positive/negative
   - Sortable columns (click header to sort)
   - Search input filters by pair name or token symbol
   - Click row to select and close modal
   - Default sort: 24h volume descending

3. Wire it into AgentConfigForm.vue replacing current pair picker

Use the existing DexScreener client patterns. Commit as one feature.
```

---

## Phase F — Agent Manager (task 4.1)

```
Read task2.md section 4.1 carefully. This is the largest feature.

IMPORTANT: Implement this incrementally. Do NOT try to build everything at once.

Step 1 — Data model:
- Add agent_managers table (id, name, owner_address, config JSON, status, created_at, updated_at)
- Add agent_manager_logs table (id, manager_id, action, reasoning, result, created_at)
- Add manager_id nullable FK to agents table
- Run migration

Step 2 — Manager Durable Object:
- Create AgentManager DO similar to TradingAgent DO
- Implement decision loop on configurable interval (alarm-based, same pattern as trading agent)
- Each cycle: fetch all managed agents → evaluate performance → decide actions
- Actions: create agent, pause agent, modify agent params, terminate agent
- All decisions logged to agent_manager_logs

Step 3 — Memory system:
- Store manager memory as structured JSON in DO storage
- Track: hypotheses tested, parameter changes and their outcomes, what worked per market condition
- Implement periodic re-evaluation (every N cycles, review assumptions)

Step 4 — API routes:
- CRUD for managers (same pattern as agent routes)
- POST /api/managers/:id/start, /stop, /pause
- GET /api/managers/:id/logs
- GET /api/managers/:id/agents (agents managed by this manager)

Step 5 — Frontend:
- Manager creation form (name, loop interval, LLM, temperature, risk params)
- Manager detail page: managed agents, recent decisions, memory log, performance overview
- Add "Managers" section to navigation

Step 6 — Research agents (if time):
- Manager can spawn short-lived analysis tasks (not full agents)
- These fetch market data, analyze trends, return findings to manager
- Manager incorporates findings into next decision

Do NOT implement A/B testing or alerting yet — mark them as TODO.
Commit after each step. Test that each step works before proceeding.
```

---

## Phase G — Design Overhaul (task 5.1)

```
Read task2.md section 5.1. Implement a theme system with 5 themes.

1. First, audit the entire frontend for hardcoded colors, backgrounds, borders.
   List every file and line that needs to change.

2. Create a CSS custom properties system:
   - Define all themeable values as CSS variables on :root
   - Variables needed: --bg-primary, --bg-secondary, --bg-card, --text-primary, --text-secondary, --accent, --accent-hover, --border, --success, --danger, --warning, plus any others you find necessary

3. Replace all hardcoded colors in the codebase with CSS variables.

4. Create 5 themes (each as a CSS class on <html> or <body>):
   - dark-terminal (default): dark bg, green/cyan accents, monospace data
   - light-clean: white/gray, blue accents, professional
   - midnight-blue: navy bg, gold/amber accents, subtle gradients
   - cyberpunk: dark + neon pink/purple/electric blue, glowing borders
   - paper: warm off-white, serif headers, minimal borders

5. Add theme switcher in user settings (persist to localStorage, apply on load).

6. Verify WCAG AA contrast ratios for text in each theme.

Commit: variables system → color migration → themes → switcher.
```

---

## Phase H — Tests (task 6.1)

```
Read task2.md section 6.1. Write comprehensive tests for the entire app.

1. Set up Vitest with coverage reporting if not already configured.

2. Write tests in this priority order:
   a. Paper engine (trade execution, PnL calculation, slippage) — most critical logic
   b. Agent config validation (Zod schemas, bounds checking)
   c. API route handlers (auth, CRUD, error responses)
   d. Component tests (AgentConfigForm, AgentCard, dashboard states)
   e. Integration: agent create → start → trade → stop → check results
   f. Auth flow: connect → sign → access → disconnect → blocked

3. For each test file, include at least one negative test (invalid input, unauthorized access, API failure).

4. After all tests are written, run coverage and create TEST_REVIEW.md documenting:
   - Current coverage percentage
   - Critical paths that are/aren't covered
   - Tests that are shallow or tautological
   - Recommendations for additional tests

Target: 80% line coverage minimum. Commit test files grouped by domain.
```

---

## Execution Notes

- Total phases: 8 (A through H)
- Estimated sessions: 8–10 (some phases may need a follow-up session)
- After each phase: review diff, test manually, commit, then start next phase
- If Claude Code asks a question: it means the task description is ambiguous — answer it, don't tell it to decide (better to clarify once than debug later)
- If something breaks between phases: fix it in a dedicated mini-session before continuing