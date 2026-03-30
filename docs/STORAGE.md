# Storage Architecture

Heppy Market runs entirely on Cloudflare primitives. Every storage choice was driven by one constraint: **Workers have no filesystem and no long-lived process memory** — so state must live in the right Cloudflare service depending on access pattern, consistency needs, and TTL.

---

## Storage Map

```
                         +-----------+
                         |  Browser  |
                         +-----+-----+
                               |
                  sessionStorage (OAuth PKCE)
                  localStorage  (UX prefs)
                  useClientCache Map (GET response memoization)
                               |
                   +-----------+-----------+
                   |     Nuxt SPA (web)    |
                   +-----------+-----------+
                               | /api proxy
                   +-----------+-----------+
                   |   Hono Worker (api)   |
                   +--+------+------+------+
                      |      |      |      |
                 +----+  +---+  +---+  +---+-----+
                 | D1 |  | KV|  | DO|  | Queue   |
                 +----+  +---+  +---+  +---------+
```

---

## 1. D1 (SQLite) — Source of Truth

**What**: Cloudflare's serverless relational database (SQLite at the edge).

**Why D1 and not Postgres/Neon/Turso**:
- Zero config — comes free with Workers, no external service to provision.
- SQL with migrations — Drizzle ORM gives type-safe queries and a migration workflow (`drizzle-kit`).
- Transactional writes — trades and decisions need atomic inserts (a half-written trade is worse than no trade).
- Queryable audit trail — performance snapshots, trade history, and decision logs are immutable append-only data that powers charts and analytics on the frontend.

**What lives here (9 tables)**:

| Table | Purpose | Write frequency |
|-------|---------|-----------------|
| `users` | Wallet addresses, encrypted API keys, roles | On sign-up, key update |
| `agents` | Agent config, status, LLM model, persona | On create/edit |
| `trades` | Every paper trade (entry, exit, P&L, reasoning) | Every agent tick that trades |
| `agentDecisions` | Full LLM call history (prompt, response, latency, tokens, market snapshot) | Every agent tick |
| `performanceSnapshots` | Hourly balance, win rate, Sharpe, drawdown | Hourly cron |
| `agentManagers` | Manager config, status | On create/edit |
| `agentManagerLogs` | Manager actions + reasoning | Every manager tick |
| `agentSelfModifications` | Agent self-modification requests | When LLM suggests config changes |
| `behaviorProfiles` | Reusable behavior presets (risk appetite, trading style) | Rarely (admin/user creation) |

**Schema location**: `apps/api/src/db/schema.ts`
**Migrations**: `apps/api/src/db/migrations/` (11 files, 0001 through 0011)

---

## 2. KV (Workers KV) — Fast Distributed Cache

**What**: Cloudflare's globally-distributed key-value store. Eventually consistent, sub-10ms reads.

**Why KV and not D1 for these**:
- Session lookups happen on every authenticated request — D1 round-trips add 10-30ms each. KV is <5ms.
- Market data (pair prices, OHLCV) is fetched from external APIs with aggressive TTLs. KV acts as a shared L2 cache across all Worker isolates.
- Nonces and rate-limit counters are ephemeral — they don't belong in the relational schema.

**Binding**: `CACHE`

**Key patterns**:

| Key | TTL | Value | Why KV |
|-----|-----|-------|--------|
| `session:{token}` | 7 days | `SessionData` JSON | Auth hot path, every request |
| `nonce:{nonce}` | 5 min | `'1'` (sentinel) | One-time SIWE nonces, short-lived |
| `rl:ip:{ip}:{window}` | 2x window | Counter string | IP-based rate limiting |
| `gecko:{chain}:{pool}:{timeframe}` | 15 min | OHLCV JSON | GeckoTerminal price cache |
| `dex:{chain}:{pair}` | 15 min | Pair data JSON | DexScreener price/volume cache |
| `models:free` | variable | Model list JSON | OpenRouter free model cache |

**Dual-persistence pattern (sessions)**:
Sessions are written to both KV and D1. KV is the fast path; D1 is the fallback if KV has an incident. This gives speed + durability without introducing an external Redis.

---

## 3. Durable Object Storage — Per-Agent Persistent State

**What**: Each Durable Object (DO) gets its own transactional SQLite-backed storage that survives eviction.

**Why DO storage and not D1 for agent runtime state**:
- **Atomicity without coordination**: Each agent is a single DO instance. Its alarm fires, reads state, runs the analysis loop, writes updated state — all sequential, no race conditions. If two requests hit D1 for the same agent, they could interleave.
- **Self-scheduling**: DOs have `setAlarm()` — no external cron needed per agent. The agent schedules its own next tick.
- **Locality**: The DO's state is colocated with its execution. Reading `engineState` from DO storage is a local SQLite read, not a network round-trip to D1.

**3 Durable Object classes**:

### TradingAgentDO (one instance per agent)

| Storage key | Type | Purpose |
|-------------|------|---------|
| `agentId` | string | Links DO instance to D1 agent row |
| `status` | `'running'\|'stopped'\|'paused'` | Execution state |
| `engineState` | Serialized PaperEngine | Balance + all open/closed positions |
| `analysisInterval` | string | Tick frequency (1m–1d) |
| `cachedAgentRow` | Agent config JSON | Avoids D1 read on every tick |
| `nextAlarmAt` | Unix timestamp | Scheduled alarm (self-healing if overdue by >10s) |
| `isLoopRunning` | timestamp | Lock with 10min TTL, prevents concurrent alarm execution |
| `recentDecisions` | Decision array | Cached from D1 after first fetch |
| `pendingLlmContext_{jobId}` | Market context | Saved when LLM job is enqueued, consumed when result arrives |
| `storageVersion` | number | Migration sentinel for DO schema changes |

### AgentManagerDO (one instance per manager)
Same pattern — status, config cache, alarm scheduling. Manages fleet-level decisions.

### GlobalRateLimiterDO (one instance per user)

| Storage key | Type | Purpose |
|-------------|------|---------|
| `minute` | Window counter | 10 LLM calls/min (atomic increment) |
| `hour` | Window counter | 120 LLM calls/hour (atomic increment) |

**Why a DO for rate limiting**: KV is eventually consistent — two concurrent LLM calls could both read "9 calls" and both pass. DO storage is strongly consistent within the instance, so the counter is atomic.

---

## 4. In-Memory Caches (per Worker Isolate)

**What**: Plain `Map` objects in module scope. Cleared when the Worker isolate is evicted (no persistence guarantee).

**Why in-memory on top of KV**: KV reads are fast (~5ms) but not free. When multiple agents analyze the same pair in the same tick, or when auth middleware checks the same session 20 times in a burst, the hot cache absorbs the load.

| Cache | Location | TTL | Max entries | Cleanup interval | Purpose |
|-------|----------|-----|-------------|------------------|---------|
| `sessionHotCache` | `lib/auth.ts` | 30s | 5,000 | Every 10s | Suppress KV reads for session validation |
| `memoryCounters` | `lib/rate-limit.ts` | 2x window | 10,000 | Every 30s | IP-based rate limiting (non-distributed) |
| GeckoTerminal `hotCache` | `services/gecko-terminal.ts` | 20s | 2,000 | Every 10s | Suppress KV for OHLCV fetches |
| DexScreener `hotCache` | `services/dex-data.ts` | 20s | 2,000 | Every 10s | Suppress KV for price/volume fetches |

**All caches have hard caps + periodic cleanup** to prevent memory leaks in long-lived isolates.

---

## 5. Cloudflare Queue — Async LLM Processing

**What**: Durable message queue with at-least-once delivery.

**Why a queue and not just inline calls**:
- LLM calls take 30–90 seconds. Blocking the DO alarm for that long wastes compute.
- The queue provides built-in retry (3 attempts, exponential backoff) and a dead-letter queue (`llm-jobs-dlq`) for debugging failures.
- Batch processing (up to 10 messages per batch) amortizes overhead.

**Binding**: `LLM_QUEUE` (optional — if absent, the agent-loop falls back to synchronous inline calls, which is fine for local dev)

**Message shape** (`LlmJobMessage`):
```
{
  agentId: string           // DO instance name
  jobId: string             // UUID for idempotency
  llmConfig: LLMRouterConfig // Model, API key, timeout
  tradeRequest: TradeDecisionRequest // Full market context
}
```

**Flow**: Agent DO enqueues job → Queue consumer calls LLM → Posts result back to DO via `/receive-decision` → DO executes trade using saved `pendingLlmContext_{jobId}`.

---

## 6. Client-Side Storage (Web App)

Minimal — the SPA is mostly stateless, relying on API calls + TanStack Query cache.

| Mechanism | Key | Purpose | Location |
|-----------|-----|---------|----------|
| `sessionStorage` | `OPENROUTER_VERIFIER` | PKCE code verifier (OAuth flow) | `composables/useOpenRouter.ts` |
| `sessionStorage` | `OPENROUTER_STATE` | OAuth state param | `composables/useOpenRouter.ts` |
| `localStorage` | `autoNamePrefKey` | Remember manager name prefix preference | `components/ManagerConfigForm.vue` |
| In-memory `Map` | `trades:*`, `stats:*` | GET response memoization with TTL | `composables/useClientCache.ts` |
| TanStack Query cache | Various query keys | Automatic request deduplication + stale-while-revalidate | All composables |

**No IndexedDB, no service worker cache**. Auth state is a server-set HttpOnly cookie — the SPA never sees or stores the session token.

---

## 7. The 3-Tier Cache Pattern (Market Data)

Market data flows through three tiers before hitting the external API:

```
Request for pair price
  │
  ▼
Tier 1: In-memory hot cache (Map)
  TTL: 20s │ Hit? → return
  │ Miss
  ▼
Tier 2: KV namespace
  TTL: 15min │ Hit? → populate hot cache → return
  │ Miss
  ▼
Tier 3: External API (DexScreener / GeckoTerminal)
  │ Success? → write KV + hot cache → return
  │ Failure? → return stale/null
```

**Why 3 tiers**:
- **Hot cache (20s)**: Multiple agents analyzing the same pair in the same alarm window get instant data. No KV amplification.
- **KV (15min)**: Shares data across Worker isolates (different requests). Market data older than 15min is stale enough to re-fetch.
- **API**: External rate limits (DexScreener: ~300 req/min, GeckoTerminal: ~30 req/min). Caching prevents hitting these limits with 50+ agents.

---

## 8. Why Not \<X\>?

| Alternative | Why not |
|-------------|---------|
| **Redis (Upstash)** | KV + DO storage covers all caching/locking needs. Redis would add a billing line and an external dependency for no benefit. |
| **Postgres (Neon/Supabase)** | D1 is free, zero-config, and sufficient for the write patterns (append-only logs, low-frequency config updates). Postgres would be warranted if we needed JOINs across millions of rows or full-text search. |
| **R2 (object storage)** | No file uploads or large blobs to store. If we add chart image exports or trade report PDFs, R2 would be the right choice. |
| **External message queue (SQS, Kafka)** | Cloudflare Queues is native to the Workers runtime — no cross-network hop, no separate auth. The LLM workload is low-throughput (dozens of messages/hour, not millions). |
| **Browser localStorage for auth** | Storing session tokens client-side opens XSS attack surface. HttpOnly cookies are safer — the browser sends them automatically and JS can't read them. |

---

## 9. Data Lifecycle

```
Ephemeral (seconds)     In-memory hot caches, rate-limit counters
Short-lived (minutes)   SIWE nonces (5min), KV market data (15min)
Session (days)          Session tokens (7d KV + D1), PKCE verifiers (session tab)
Persistent (forever)    Trades, decisions, snapshots, user accounts (D1)
DO-persistent           Agent engine state, alarm schedule (survives DO eviction)
```

---

## 10. Encryption at Rest

| Data | Encryption | Key source |
|------|-----------|------------|
| User OpenRouter API keys | AES-GCM | `KEY_ENCRYPTION_SECRET` env var (64-char hex) |
| Session tokens | Plaintext in KV/D1 | Protected by HTTPS + HttpOnly cookie |
| D1 database | Cloudflare-managed encryption at rest | Automatic |
| KV values | Cloudflare-managed encryption at rest | Automatic |
| DO storage | Cloudflare-managed encryption at rest | Automatic |
