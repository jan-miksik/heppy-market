# Phase 1: Foundation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Initialize a Turborepo monorepo with a working Cloudflare Workers + Hono API that serves a health endpoint and connects to a D1 SQLite database.

**Architecture:** Root Turborepo workspace with `apps/api` (Cloudflare Workers + Hono) and `apps/web` (Nuxt 4 stub). The API uses Drizzle ORM to define the full DB schema, applies migrations to local D1, and exposes a `/api/health` endpoint. A stub Durable Object is defined to satisfy wrangler.toml bindings.

**Tech Stack:** Node 22, npm workspaces, Turborepo, Hono 4, Wrangler 3, Drizzle ORM, Drizzle Kit, Zod, TypeScript strict, @cloudflare/workers-types

---

### Task 1: Install Wrangler globally + initialize git

**Files:**

- N/A (shell operations)

**Step 1: Install wrangler globally**

```bash
npm install -g wrangler
wrangler --version
```

Expected: version printed (3.x)

**Step 2: Initialize git repo**

```bash
cd /Users/janmiksik/Desktop/projects/own/+/heppy-market
git init
git add CLAUDE.md notes.txt docs/
git commit -m "chore: initial commit with spec and plan"
```

---

### Task 2: Create root Turborepo structure

**Files:**

- Create: `package.json`
- Create: `turbo.json`
- Create: `.gitignore`
- Create: `tsconfig.base.json`

**Step 1: Write root package.json**

```json
{
  "name": "dex-trading-agents",
  "private": true,
  "workspaces": ["apps/*", "packages/*"],
  "scripts": {
    "dev": "turbo run dev",
    "build": "turbo run build",
    "test": "turbo run test",
    "lint": "turbo run lint"
  },
  "devDependencies": {
    "turbo": "^2.0.0",
    "typescript": "^5.4.0"
  }
}
```

**Step 2: Write turbo.json**

```json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "build": {
      "dependsOn": ["^build"],
      "outputs": ["dist/**"]
    },
    "dev": {
      "cache": false,
      "persistent": true
    },
    "test": {
      "dependsOn": ["^build"]
    }
  }
}
```

**Step 3: Write .gitignore**

```
node_modules/
dist/
.wrangler/
*.local
.env
.dev.vars
*.tsbuildinfo
```

**Step 4: Write tsconfig.base.json**

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true,
    "skipLibCheck": true
  }
}
```

**Step 5: Install root dependencies**

```bash
cd /Users/janmiksik/Desktop/projects/own/+/heppy-market
npm install
```

Expected: `node_modules/` created, turbo installed.

**Step 6: Commit**

```bash
git add package.json turbo.json .gitignore tsconfig.base.json
git commit -m "chore: initialize turborepo monorepo root"
```

---

### Task 3: Create apps/api structure and install dependencies

**Files:**

- Create: `apps/api/package.json`
- Create: `apps/api/tsconfig.json`
- Create: `apps/api/drizzle.config.ts`

**Step 1: Create directory**

```bash
mkdir -p apps/api/src/routes apps/api/src/agents apps/api/src/db/migrations apps/api/src/types apps/api/src/lib
mkdir -p apps/web
```

**Step 2: Write apps/api/package.json**

```json
{
  "name": "@dex-trading/api",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "dev": "wrangler dev",
    "deploy": "wrangler deploy",
    "test": "vitest run",
    "test:watch": "vitest",
    "db:generate": "drizzle-kit generate",
    "db:migrate:local": "wrangler d1 migrations apply trading-agents --local",
    "db:migrate:remote": "wrangler d1 migrations apply trading-agents"
  },
  "dependencies": {
    "hono": "^4.6.0",
    "drizzle-orm": "^0.36.0",
    "zod": "^3.23.0",
    "nanoid": "^5.0.0"
  },
  "devDependencies": {
    "@cloudflare/workers-types": "^4.20241205.0",
    "@cloudflare/vitest-pool-workers": "^0.5.0",
    "drizzle-kit": "^0.28.0",
    "typescript": "^5.4.0",
    "vitest": "^2.1.0",
    "wrangler": "^3.87.0"
  }
}
```

**Step 3: Write apps/api/tsconfig.json**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "lib": ["ESNext"],
    "types": ["@cloudflare/workers-types"],
    "noEmit": true
  },
  "include": ["src/**/*", "*.ts", "*.config.ts"]
}
```

**Step 4: Write apps/api/drizzle.config.ts**

```typescript
import type { Config } from "drizzle-kit";

export default {
  schema: "./src/db/schema.ts",
  out: "./src/db/migrations",
  dialect: "sqlite",
} satisfies Config;
```

**Step 5: Install API dependencies**

```bash
cd /Users/janmiksik/Desktop/projects/own/+/heppy-market
npm install
```

Expected: hono, drizzle-orm, zod, nanoid, wrangler installed in apps/api.

---

### Task 4: Write wrangler.toml

**Files:**

- Create: `apps/api/wrangler.toml`

**Step 1: Create wrangler.toml — NOTE: database_id is set to empty string for local dev; wrangler will prompt to create or use local**

```toml
name = "dex-trading-agents-api"
main = "src/index.ts"
compatibility_date = "2024-11-01"
compatibility_flags = ["nodejs_compat"]

[[d1_databases]]
binding = "DB"
database_name = "trading-agents"
database_id = "00000000-0000-0000-0000-000000000000"

[[kv_namespaces]]
binding = "CACHE"
id = "00000000000000000000000000000000"

[durable_objects]
bindings = [
  { name = "TRADING_AGENT", class_name = "TradingAgentDO" }
]

[[migrations]]
tag = "v1"
new_classes = ["TradingAgentDO"]

[triggers]
crons = [
  "*/1 * * * *",
  "*/5 * * * *",
  "*/15 * * * *",
  "0 * * * *",
  "0 */4 * * *",
  "0 0 * * *"
]

[dev]
port = 8787

[vars]
ENVIRONMENT = "development"
```

**Step 2: Create .dev.vars template**

Create `apps/api/.dev.vars`:

```
OPENROUTER_API_KEY=sk-or-v1-replace-me
```

---

### Task 5: Write Drizzle schema

**Files:**

- Create: `apps/api/src/db/schema.ts`

**Step 1: Write schema.ts**

```typescript
import { sqliteTable, text, real, integer } from "drizzle-orm/sqlite-core";

export const agents = sqliteTable("agents", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  status: text("status", { enum: ["running", "stopped", "paused"] })
    .notNull()
    .default("stopped"),
  autonomyLevel: text("autonomy_level", {
    enum: ["full", "guided", "strict"],
  }).notNull(),
  config: text("config").notNull(), // JSON blob
  llmModel: text("llm_model").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const trades = sqliteTable("trades", {
  id: text("id").primaryKey(),
  agentId: text("agent_id")
    .notNull()
    .references(() => agents.id),
  pair: text("pair").notNull(),
  dex: text("dex", { enum: ["aerodrome", "uniswap-v3"] }).notNull(),
  side: text("side", { enum: ["buy", "sell"] }).notNull(),
  entryPrice: real("entry_price").notNull(),
  exitPrice: real("exit_price"),
  amountUsd: real("amount_usd").notNull(),
  pnlPct: real("pnl_pct"),
  pnlUsd: real("pnl_usd"),
  confidenceBefore: real("confidence_before").notNull(),
  confidenceAfter: real("confidence_after"),
  reasoning: text("reasoning").notNull(),
  strategyUsed: text("strategy_used").notNull(),
  slippageSimulated: real("slippage_simulated").notNull().default(0.003),
  status: text("status", { enum: ["open", "closed", "stopped_out"] }).notNull(),
  openedAt: text("opened_at").notNull(),
  closedAt: text("closed_at"),
});

export const agentDecisions = sqliteTable("agent_decisions", {
  id: text("id").primaryKey(),
  agentId: text("agent_id").notNull(),
  decision: text("decision", {
    enum: ["buy", "sell", "hold", "close"],
  }).notNull(),
  confidence: real("confidence").notNull(),
  reasoning: text("reasoning").notNull(),
  llmModel: text("llm_model").notNull(),
  llmLatencyMs: integer("llm_latency_ms").notNull(),
  llmTokensUsed: integer("llm_tokens_used"),
  marketDataSnapshot: text("market_data_snapshot").notNull(), // JSON
  createdAt: text("created_at").notNull(),
});

export const performanceSnapshots = sqliteTable("performance_snapshots", {
  id: text("id").primaryKey(),
  agentId: text("agent_id").notNull(),
  balance: real("balance").notNull(),
  totalPnlPct: real("total_pnl_pct").notNull(),
  winRate: real("win_rate").notNull(),
  totalTrades: integer("total_trades").notNull(),
  sharpeRatio: real("sharpe_ratio"),
  maxDrawdown: real("max_drawdown"),
  snapshotAt: text("snapshot_at").notNull(),
});
```

---

### Task 6: Generate D1 migration and apply locally

**Files:**

- Create: `apps/api/src/db/migrations/0000_initial.sql` (auto-generated by drizzle-kit)

**Step 1: Generate migration**

```bash
cd /Users/janmiksik/Desktop/projects/own/+/heppy-market/apps/api
npx drizzle-kit generate
```

Expected: `src/db/migrations/0000_*.sql` created with CREATE TABLE statements.

**Step 2: Apply migration to local D1**

```bash
cd /Users/janmiksik/Desktop/projects/own/+/heppy-market/apps/api
npx wrangler d1 migrations apply trading-agents --local
```

Expected: "✅ Applied 1 migration(s)" or similar.

**Step 3: Verify D1 works**

```bash
cd /Users/janmiksik/Desktop/projects/own/+/heppy-market/apps/api
npx wrangler d1 execute trading-agents --local --command "SELECT name FROM sqlite_master WHERE type='table'"
```

Expected: tables listed: agents, trades, agent_decisions, performance_snapshots.

---

### Task 7: Write types, health route, stub Durable Object, and main app

**Files:**

- Create: `apps/api/src/types/bindings.ts`
- Create: `apps/api/src/agents/trading-agent.ts`
- Create: `apps/api/src/routes/health.ts`
- Create: `apps/api/src/index.ts`

**Step 1: Write bindings.ts**

```typescript
export interface Bindings {
  DB: D1Database;
  CACHE: KVNamespace;
  TRADING_AGENT: DurableObjectNamespace;
  OPENROUTER_API_KEY: string;
  ENVIRONMENT: string;
}
```

**Step 2: Write trading-agent.ts stub**

```typescript
import { DurableObject } from "cloudflare:workers";
import type { Bindings } from "../types/bindings";

/**
 * TradingAgentDO — Durable Object for per-agent state management.
 * Stub for Phase 1. Full implementation in Phase 3.
 */
export class TradingAgentDO extends DurableObject<Bindings> {
  async fetch(_request: Request): Promise<Response> {
    return new Response(JSON.stringify({ status: "not_implemented" }), {
      headers: { "Content-Type": "application/json" },
    });
  }
}
```

**Step 3: Write health.ts**

```typescript
import { Hono } from "hono";
import type { Bindings } from "../types/bindings";

const health = new Hono<{ Bindings: Bindings }>();

/**
 * GET /api/health — Returns API status and D1 connectivity.
 */
health.get("/", async (c) => {
  let dbStatus: "connected" | "error" = "connected";
  try {
    await c.env.DB.prepare("SELECT 1").first();
  } catch {
    dbStatus = "error";
  }

  return c.json({
    status: "ok",
    db: dbStatus,
    environment: c.env.ENVIRONMENT ?? "unknown",
    timestamp: new Date().toISOString(),
  });
});

export default health;
```

**Step 4: Write index.ts**

```typescript
import { Hono } from "hono";
import { cors } from "hono/cors";
import health from "./routes/health";
import type { Bindings } from "./types/bindings";

export { TradingAgentDO } from "./agents/trading-agent";

const app = new Hono<{ Bindings: Bindings }>();

app.use(
  "*",
  cors({
    origin: ["http://localhost:3000", "https://*.pages.dev"],
    allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
  }),
);

app.route("/api/health", health);

// 404 fallback
app.notFound((c) => c.json({ error: "Not found" }, 404));

export default app;
```

---

### Task 8: Initialize apps/web (Nuxt 4 stub)

**Files:**

- Create: `apps/web/package.json`
- Create: `apps/web/nuxt.config.ts`
- Create: `apps/web/app.vue`

**Step 1: Write apps/web/package.json**

```json
{
  "name": "@dex-trading/web",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "dev": "nuxt dev",
    "build": "nuxt build",
    "preview": "nuxt preview"
  },
  "dependencies": {
    "nuxt": "^3.14.0"
  }
}
```

**Step 2: Write apps/web/nuxt.config.ts**

```typescript
export default defineNuxtConfig({
  devtools: { enabled: true },
  runtimeConfig: {
    public: {
      apiBase: process.env.NUXT_PUBLIC_API_BASE ?? "http://localhost:8787",
    },
  },
});
```

**Step 3: Write apps/web/app.vue (minimal stub)**

```vue
<template>
  <div>
    <h1>Heppy Market</h1>
    <p>Platform loading...</p>
  </div>
</template>
```

---

### Task 9: Run Phase 1 tests

**Step 1: Start wrangler dev in background**

```bash
cd /Users/janmiksik/Desktop/projects/own/+/heppy-market/apps/api
npx wrangler dev --local &
sleep 5  # wait for startup
```

Expected: "Ready on http://localhost:8787"

**Step 2: Test health endpoint**

```bash
curl -s http://localhost:8787/api/health | python3 -m json.tool
```

Expected:

```json
{
  "status": "ok",
  "db": "connected",
  "environment": "development",
  "timestamp": "2026-02-14T..."
}
```

**Step 3: Test D1 directly**

```bash
cd /Users/janmiksik/Desktop/projects/own/+/heppy-market/apps/api
npx wrangler d1 execute trading-agents --local --command "SELECT 1"
```

Expected: `{ "results": [{"1": 1}] }`

**Step 4: Stop wrangler dev**

```bash
kill %1 2>/dev/null || true
```

**Step 5: Commit Phase 1**

```bash
cd /Users/janmiksik/Desktop/projects/own/+/heppy-market
git add -A
git commit -m "feat: phase 1 foundation — turborepo monorepo, hono api, d1 schema, health endpoint"
```

---

## Phase 1 Complete Checklist

- [ ] `wrangler dev` starts without errors on port 8787
- [ ] `curl localhost:8787/api/health` returns `{"status":"ok","db":"connected",...}`
- [ ] `wrangler d1 execute trading-agents --local --command "SELECT 1"` returns result
- [ ] All 4 DB tables exist (agents, trades, agent_decisions, performance_snapshots)
- [ ] Git commit created
