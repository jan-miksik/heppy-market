# Claude Code Audit — initRoot / heppy-market

**Date:** 2026-04-16  
**Scope:** Full codebase — API (Cloudflare Workers / Hono), frontend (Nuxt 4 SPA), shared package  
**Mode:** General (architecture, bugs, security, performance, code quality)

---

## Executive Summary

The codebase is generally well-structured for a Cloudflare-native stack. The Durable Object lifecycle, alarm-based scheduling, and two-layer caching (in-memory hot cache + KV) are sound. The main risk areas are: (1) a short-position P&L bug in `PaperEngine` that can produce a negative balance, (2) LLM API keys flowing through Cloudflare Queues messages in plaintext, (3) SIWE message parsing that skips EIP-4361 temporal fields, and (4) silent data truncation (pairs capped at 5 without user feedback). Code quality issues — duplicate hot-cache implementations, `as any` casts, missing FK constraints — create maintenance debt.

---

## Critical Issues

### 1. Short Position Can Drive Balance Negative (`paper-engine.ts:192–199`)

**Severity: High (financial math bug)**

The short close formula is:
```ts
const buyBackCost = position.tokenAmount * effectiveExitPrice;
proceedsUsd = position.amountUsd * 2 - buyBackCost;
```

This is correct for modest price moves, but if the asset price rises beyond `2 × effectiveEntryPrice`, `buyBackCost > 2 × amountUsd`, so `proceedsUsd` goes **negative**. Since `this.state.balance += proceedsUsd` is applied without a floor, the balance goes negative. Stop-loss checks in `risk-controls.ts` should prevent this, but:

- If `resolveCurrentPriceUsd` returns 0 (lines 55–68), stop-loss checks are **skipped** for that tick.
- If a price spike happens between ticks, the short can be closed at a price that puts balance below zero.

**Fix:** Clamp `proceedsUsd` to `0` at minimum (representing total collateral loss), or add a `balance >= 0` invariant after every operation.

```ts
// After calculating proceedsUsd for shorts:
proceedsUsd = Math.max(0, proceedsUsd);
```

---

### 2. LLM API Key Transmitted in Cloudflare Queue Message (`agent-loop/queue.ts:84–99`)

**Severity: High (secret exposure)**

`enqueueLlmJob` serialises the full `llmConfig` including `apiKey` into the queue message body:

```ts
const message: LlmJobMessage = {
  agentId,
  jobId,
  llmConfig: {
    apiKey: llmApiKey,  // ← plaintext API key in queue payload
    ...
  },
  tradeRequest,
};
await env.LLM_QUEUE.send(message);
```

Cloudflare Queues messages can appear in Workers logs, DLQ, and Cloudflare's dashboard. Any API key in a queue message is effectively a secret stored in an external system with broader visibility than a Worker secret.

**Fix:** Instead of sending the raw key, reference a secret alias or rediscover the key in the queue consumer from the per-user encrypted column in D1. The consumer already has access to `env` and can look up the decrypted key by `agentId → ownerAddress → users.openRouterKey`.

---

### 3. SIWE Verification Missing Temporal Fields (`lib/auth/siwe.ts`)

**Severity: Medium-High (auth weakness)**

`parseSiweMessage` extracts `address`, `nonce`, `chainId`, and `domain` but **ignores** EIP-4361 fields:
- `Issued At` — message timestamp
- `Expiration Time` — when the signature expires
- `Not Before` — earliest valid time
- `URI` — intended app URL

A valid nonce is consumed, but an attacker who captures a signed SIWE message (e.g. via XSS or MITM) has a window until the nonce is used; after that they cannot re-use the same nonce — but they could sign a new message with the stolen private key. More importantly, **the `Expiration Time` field is never enforced**, meaning a captured message with a far-future expiry remains valid indefinitely (until the nonce is spent).

The SIWE message parser is also fragile (custom string-split logic), e.g.:
- `address = lines[1]?.trim()` — assumes line 2 is always the address (true per spec, but no fallback).
- Domain extraction: `(lines[0] ?? '').split(' wants you to')[0]` — breaks if the domain contains the literal string "wants you to".

**Recommendation:** Use the canonical `siwe` npm package for parsing and verification, or at minimum enforce `Expiration Time < now + MAX_WINDOW` from the message body.

---

### 4. Hackathon Auth Bypass Endpoint in Production Code (`routes/auth.ts:117–157`)

**Severity: Medium (auth bypass risk)**

`POST /api/auth/hackathon-session` creates a full session from any wallet address without signature verification:

```ts
if (!isHackathonBypassAllowed(c.env)) {
  return notFoundJson(c);
}
// ... creates a session from body.walletAddress with no proof of ownership
```

If `HACKATHON_AUTH_BYPASS=true` is accidentally set in production (or copied from a dev `.vars` file), any actor can impersonate any wallet address. The endpoint is not authenticated, rate-limited, or logged distinctly.

**Fix:** Either delete this endpoint for non-hackathon builds, or add a `hackathon-bypass` audit log entry and ensure it is never deployed behind a real domain.

---

## High Issues

### 5. Missing Foreign Keys and Indexes (`db/schema.ts`)

Several tables lack referential integrity constraints:

| Table | Column | Missing |
|---|---|---|
| `agentDecisions` | `agentId` | `references(() => agents.id)` |
| `performanceSnapshots` | `agentId` | `references(() => agents.id)` |
| `agentSelfModifications` | `agentId` | `references(() => agents.id)` |
| `agentManagers` | `ownerAddress` | No FK to `users.walletAddress` |

Without FKs, deleting an agent leaves orphaned rows in all these tables (only avoided because `deleteAgentRelatedRows` manually deletes them — if that ever fails, orphans accumulate).

More critically: `agentDecisions.agentId` has **no index**, but `market.ts:41–49` and history routes query it with `WHERE agentId = ?`. On a growing table this becomes a full scan.

**Fix:**
```ts
// schema.ts — add to agentDecisions table
agentId: text('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
```
Add a Drizzle migration with `CREATE INDEX idx_agent_decisions_agent_id ON agent_decisions (agent_id)`.

---

### 6. Dynamic Imports Inside Hot WebSocket Path (`index.ts:236–247`)

```ts
async function handleAgentWebSocket(request: Request, env: Env) {
  ...
  const { drizzle } = await import('drizzle-orm/d1');  // dynamic import on every WS
  const { agents } = await import('./db/schema.js');
  const { eq } = await import('drizzle-orm');
  ...
}
```

These modules are imported statically elsewhere in the same Worker bundle, so the dynamic import is redundant and adds module-resolution overhead on every WebSocket connection.

**Fix:** Move these to static imports at the top of `index.ts`.

---

### 7. Pairs Silently Capped at 5 (`agent-loop.ts:130`)

```ts
const pairsToFetch = config.pairs.slice(0, 5).map(normalizePairForDex);
```

`AgentConfigSchema` allows up to 10 pairs, but the agent loop silently drops pairs 6–10. No warning is logged, no decision record is created, and the user has no visibility into this.

**Fix:** Either raise the cap to match the schema maximum, or emit a structured log warning when pairs are truncated.

---

## Medium Issues

### 8. KV Rate Limiter Is Not Atomic (`lib/rate-limit.ts:8`, `index.ts:33–59`)

The code already acknowledges this in a comment:
> "Cloudflare KV operations are not atomic, so this provides best-effort limiting under concurrency."

The global per-IP rate limit (`/api/*`, 200 req/min) uses `strategy: 'memory'`, which is per-isolate — multiple isolates can each allow up to 200 req/min from the same IP. Under traffic spikes with many isolates, effective limits multiply.

The `GlobalRateLimiterDO` is used correctly for LLM rate limiting (DO requests are sequential → atomic). The IP rate limit should either:
- Accept the per-isolate behaviour (acceptable for a generous 200/min limit), or
- Route through a DO for strict global enforcement.

---

### 9. `agentDecisions` decision field is case-inconsistent

Base chain agents log lowercase decisions (`'buy'`, `'sell'`, `'hold'`, `'close'`), while Initia perp agents log uppercase (`'HOLD'`, `'OPEN_LONG'`, etc.) — both into the same `agentDecisions.decision` text column. UI queries that filter or group by `decision` must handle both cases.

**Fix:** Normalise to lowercase on insert in `initia-perp.ts:128–138`, or use a union enum in the schema.

---

### 10. Extra D1 Query in `executeTradeDecision` (`agent-loop/execution.ts:82–91`)

Every trade decision triggers an extra D1 query to fetch `chain`, `isPaper`, and `initiaSyncState` from the agents table:

```ts
const [agentRow] = await db.select({
  chain: agents.chain,
  isPaper: agents.isPaper,
  initiaSyncState: agents.initiaSyncState,
}).from(agents).where(eq(agents.id, agentId)).limit(1);
```

The `chain` and `isPaper` fields are already in the DO's `cachedAgentRow`. Only `initiaSyncState` legitimately needs a live fetch (it's updated externally). The query can be split: pass `chain`/`isPaper` from the cache and only query `initiaSyncState` when `chain === 'initia'`.

---

### 11. Duplicate In-Memory Hot Cache Implementation

`gecko-terminal.ts` and `dex-data.ts` each contain an identical ~50-line hot-cache implementation (Map, cleanup function, `getHotCached`, `setHotCached`). The same pattern also appears in `lib/rate-limit.ts` and `session-store.ts`. This is four independent copies of the same logic.

**Fix:** Extract a `createInMemoryCache<T>(maxEntries, ttlMs)` utility in `lib/utils.ts` and use it everywhere.

---

### 12. `marketDataSnapshot` Unbounded JSON in `agentDecisions`

Every decision row stores a full market data snapshot as a JSON string (`marketDataSnapshot: JSON.stringify(marketData)`). As the number of pairs and candles grows, this can become multi-kilobyte rows. D1 SQLite has a default row size limit, and large snapshots will inflate storage and query times.

**Fix:** Consider storing only the pair prices/volumes as a compact summary, or cap the snapshot at a reasonable character limit.

---

### 13. `authTablesReady` Module-Level Flag Causes Misleading Behaviour

`session-store.ts:17`:
```ts
let authTablesReady = false;
let authTablesInitPromise: Promise<void> | null = null;
```

Because this is module-level, each new isolate re-runs `ensureAuthTables`. On cold starts during high traffic, many concurrent requests could each try to `CREATE TABLE IF NOT EXISTS` simultaneously. This is safe (idempotent DDL), but it adds latency to every first auth operation after an isolate starts. Cloudflare Workers run Wrangler migrations; `CREATE TABLE IF NOT EXISTS` inside request handlers is a smell.

**Fix:** Run auth table creation as part of the deployment migration, not lazily on request.

---

## Minor Issues

### 14. `as any` Casts on Known Schema Fields

`base-flow.ts:79`, `initia-perp.ts:103`:
```ts
behaviorMd: (config as any).behaviorMd ?? null,
roleMd: (config as any).roleMd ?? null,
```

Both `behaviorMd` and `roleMd` are defined in `AgentConfigSchema` (validation.ts:129–130), so the `as any` is unnecessary. These casts bypass TypeScript safety for no reason and suggest the schema and the consuming code drifted during a refactor.

**Fix:** Remove the casts and use `config.behaviorMd` directly.

---

### 15. `parseSiweMessage` — Custom Parser Instead of Library

`lib/auth/siwe.ts:23–33`: A hand-rolled SIWE message parser. EIP-4361 messages have a well-defined format and the `siwe` npm package handles all edge cases. The custom parser is brittle and doesn't validate or extract temporal fields (see Issue 3).

---

### 16. `@something-in-loop/shared` Hard-Coded Package Name

The package is imported as `@something-in-loop/shared` throughout the codebase, but the project was renamed to `initRoot`. If the package name isn't updated, npm publishing or monorepo tooling may produce confusing mismatches.

---

### 17. `HACKATHON_AUTH_BYPASS` Not Validated at Startup

If the env var is truthy but not exactly `'true'`, `isHackathonBypassAllowed` returns `false` (because it checks `=== 'true'`). No warning is emitted. A typo like `HACKATHON_AUTH_BYPASS=1` or `HACKATHON_AUTH_BYPASS=True` silently disables the bypass without developer feedback.

---

### 18. `openRouterKey` Stored Without Authenticated Encryption

`lib/crypto.ts` uses AES-GCM with a fixed `KEY_ENCRYPTION_SECRET`. This is good, but there is no authenticated additional data (AAD) binding the ciphertext to the specific user. An attacker with D1 access who can modify rows could swap one user's encrypted key into another user's row — though they'd still need the decryption secret to actually use it. This is an advanced attack vector, but worth noting.

---

### 19. `PLAYWRIGHT_SECRET` Endpoint Uses Hardcoded Wallet Address

`routes/auth.ts:259`:
```ts
const PLAYWRIGHT_WALLET = '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
```

The Playwright test session always binds to this fixed wallet. If `PLAYWRIGHT_SECRET` is set in production (even accidentally), tests could create a real user record under this address. The address should be generated dynamically or at least warn loudly when this endpoint is invoked.

---

### 20. `getDailyPnlPct` Has a Side Effect Hidden in a Getter

`paper-engine.ts:279–290`:
```ts
getDailyPnlPct(): number {
  const today = nowIso().slice(0, 10);
  if (today !== this.state.lastDailyReset) {
    this.state.dailyStartBalance = this.state.balance; // ← mutates state!
    this.state.lastDailyReset = today;
  }
  return ...;
}
```

This method mutates `dailyStartBalance` as a side effect of reading the daily PnL. If called multiple times during the same tick (e.g. in the prompt builder and in risk controls), the reset only happens once (safe), but reading a value shouldn't have write side effects. This violates the principle of least surprise.

**Fix:** Move the daily reset logic to a dedicated `resetDailyTrackingIfNeeded()` method called once per tick at the start of `runAgentLoop`.

---

## Summary Table

| # | File | Severity | Category | Description |
|---|---|---|---|---|
| 1 | `paper-engine.ts:192` | **Critical** | Bug | Short position can produce negative balance |
| 2 | `agent-loop/queue.ts:84` | **Critical** | Security | API key in queue message plaintext |
| 3 | `lib/auth/siwe.ts:23` | **High** | Security | SIWE temporal fields not validated |
| 4 | `routes/auth.ts:117` | **High** | Security | Hackathon auth bypass in production |
| 5 | `db/schema.ts` | **High** | Data integrity | Missing FKs and indexes on agentDecisions |
| 6 | `index.ts:236` | **High** | Performance | Dynamic imports in hot WebSocket path |
| 7 | `agent-loop.ts:130` | **High** | UX | Pairs silently capped at 5, config allows 10 |

| 8 | `lib/rate-limit.ts` | **Medium** | Security | KV rate limiter not atomic across isolates |
| 9 | `agent-loop/execution.ts` | Medium | Consistency | Uppercase/lowercase decision values mixed |
| 10 | `agent-loop/execution.ts:82` | Medium | Performance | Redundant D1 query per trade execution |
| 11 | `gecko-terminal.ts` + `dex-data.ts` | Medium | Maintainability | Duplicate hot-cache implementations |
| 12 | `agent-loop/execution.ts:107` | Medium | Performance | Unbounded marketDataSnapshot JSON per decision |
| 13 | `lib/auth/session-store.ts:17` | Minor | Architecture | Auth tables created lazily on first request |
| 14 | `agent-loop/base-flow.ts:79` | Minor | Code quality | Unnecessary `as any` casts on schema fields |
| 15 | `lib/auth/siwe.ts:23` | Minor | Code quality | Custom SIWE parser instead of library |
| 16 | Package name | Minor | Ops | Package name not updated after rename |
| 17 | `routes/auth.ts:83` | Minor | Reliability | `HACKATHON_AUTH_BYPASS` not validated at startup |
| 18 | `lib/crypto.ts` | Minor | Security | AES-GCM without user-bound AAD |
| 19 | `routes/auth.ts:259` | Minor | Security | Hardcoded Playwright wallet in production code |
| 20 | `paper-engine.ts:279` | Minor | Design | Getter with hidden mutation side effect |
