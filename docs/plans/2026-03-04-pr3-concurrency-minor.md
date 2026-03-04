# PR 3: Concurrency Guards & Minor Hardening — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix N+1 D1 queries in manager loop; add optimistic locking to agent PATCH; add runtime config validation; enable FK enforcement.

**Architecture:**
- N+1 fix: replace per-agent queries in `runManagerLoop()` with `inArray()` batch queries, then group results in memory.
- Optimistic locking: add `updatedAt` version check to agent PATCH endpoint. Reject with 409 if version mismatch.
- Config validation: use `AgentConfigSchema.parse()` (already in shared package) in `agent-loop.ts` instead of raw cast.
- FK: add `PRAGMA foreign_keys = ON` to a shared db initializer.

**Note on manager lock (Issue #5):** Adding a `userLocked` column requires a DB migration and front-end changes. Deferred — the risk is low in practice (manager and user rarely conflict in real usage) and adds significant scope.

**Tech Stack:** Drizzle ORM, D1/SQLite, TypeScript

---

## Context

### File map
- `apps/api/src/agents/manager-loop.ts:469–511` — N+1 per-agent queries
- `apps/api/src/routes/agents.ts` — PATCH endpoint for agent config updates
- `apps/api/src/agents/agent-loop.ts:84–103` — raw JSON cast of config
- `apps/api/src/db/schema.ts` — table definitions
- `packages/shared/src/validation.ts` — AgentConfigSchema (source of truth)

---

## Task 1: Batch N+1 queries in manager loop

**Files:**
- Modify: `apps/api/src/agents/manager-loop.ts`

### Step 1: Read current imports

Confirm `inArray` is available from drizzle-orm. Check line 9:
```typescript
import { eq, desc } from 'drizzle-orm';
```

`inArray` is not imported yet.

### Step 2: Add inArray to imports

Change line 9:
```typescript
import { eq, desc } from 'drizzle-orm';
```
to:
```typescript
import { eq, desc, inArray } from 'drizzle-orm';
```

### Step 3: Replace the per-agent query loop (lines 469–511)

Replace the entire `for (const row of managedRows)` block with:

```typescript
  // 3. Build agent snapshots — batch queries instead of N+1
  const agentSnapshots: ManagedAgentSnapshot[] = [];

  if (managedRows.length > 0) {
    const agentIds = managedRows.map((r) => r.id);

    // Batch: latest snapshot per agent
    const allSnapshots = await db
      .select()
      .from(performanceSnapshots)
      .where(inArray(performanceSnapshots.agentId, agentIds))
      .orderBy(desc(performanceSnapshots.snapshotAt));

    // Keep only the most recent snapshot per agent
    const latestSnapshotByAgent = new Map<string, typeof allSnapshots[number]>();
    for (const snap of allSnapshots) {
      if (!latestSnapshotByAgent.has(snap.agentId)) {
        latestSnapshotByAgent.set(snap.agentId, snap);
      }
    }

    // Batch: recent trades across all agents
    const allRecentTrades = await db
      .select({ agentId: trades.agentId, pair: trades.pair, side: trades.side, pnlPct: trades.pnlPct, openedAt: trades.openedAt, closedAt: trades.closedAt })
      .from(trades)
      .where(inArray(trades.agentId, agentIds))
      .orderBy(desc(trades.openedAt));

    // Group by agentId, keep top 10 each
    const tradesByAgent = new Map<string, typeof allRecentTrades>();
    for (const trade of allRecentTrades) {
      const existing = tradesByAgent.get(trade.agentId) ?? [];
      if (existing.length < 10) existing.push(trade);
      tradesByAgent.set(trade.agentId, existing);
    }

    for (const row of managedRows) {
      const agentConfig = JSON.parse(row.config) as ManagedAgentSnapshot['config'];
      const perfRow = latestSnapshotByAgent.get(row.id);
      const recentTrades = tradesByAgent.get(row.id) ?? [];

      agentSnapshots.push({
        id: row.id,
        name: row.name,
        status: row.status,
        llmModel: row.llmModel,
        config: {
          pairs: agentConfig.pairs ?? [],
          strategies: agentConfig.strategies ?? [],
          maxPositionSizePct: agentConfig.maxPositionSizePct ?? 5,
          analysisInterval: agentConfig.analysisInterval ?? '1h',
          paperBalance: agentConfig.paperBalance ?? 10000,
          temperature: agentConfig.temperature ?? 0.7,
        },
        performance: {
          balance: perfRow?.balance ?? agentConfig.paperBalance ?? 10000,
          totalPnlPct: perfRow?.totalPnlPct ?? 0,
          winRate: perfRow?.winRate ?? 0,
          totalTrades: perfRow?.totalTrades ?? 0,
          sharpeRatio: perfRow?.sharpeRatio ?? null,
          maxDrawdown: perfRow?.maxDrawdown ?? null,
        },
        recentTrades,
      });
    }
  }
```

### Step 4: Build check

```bash
npm run build:worker 2>&1 | tail -20
```

Expected: no errors

### Step 5: Commit

```bash
git add apps/api/src/agents/manager-loop.ts
git commit -m "fix(manager-loop): replace N+1 D1 queries with batch inArray queries"
```

---

## Task 2: Optimistic locking on agent PATCH

**Files:**
- Modify: `apps/api/src/routes/agents.ts`

### Step 1: Read the PATCH endpoint

Find the PATCH `/:id` handler (it reads existing config and does `db.update(agents).set(updates).where(eq(agents.id, id))`).

### Step 2: Accept optional version field in request body

In the PATCH handler, after reading and validating the body, extract an optional `_version` field:

```typescript
  // Optional optimistic lock: client passes the updatedAt it last saw
  const clientVersion = typeof (body as any)._version === 'string' ? (body as any)._version : null;
```

### Step 3: Add version check before update

After `const existing = await requireOwnership(...)`, add:

```typescript
  if (clientVersion && existing.updatedAt !== clientVersion) {
    return c.json(
      { error: 'Conflict: agent was modified by another request. Reload and retry.', code: 'VERSION_CONFLICT' },
      409
    );
  }
```

### Step 4: Verify existing.updatedAt is populated

Check `schema.ts` for the `updatedAt` column — it should be a `text` (ISO string). Confirm `nowIso()` is used on insert/update (it is, based on existing routes).

### Step 5: Commit

```bash
git add apps/api/src/routes/agents.ts
git commit -m "fix(agents-route): add optimistic locking via updatedAt version check on PATCH"
```

---

## Task 3: Runtime config validation in agent-loop

**Files:**
- Modify: `apps/api/src/agents/agent-loop.ts`

### Step 1: Check AgentConfigSchema import path

```bash
grep -r "AgentConfigSchema" packages/shared/src/
```

Expected: found in `packages/shared/src/validation.ts`

### Step 2: Check existing import in agent-loop.ts

Line 20:
```typescript
import type { AgentBehaviorConfig } from '@dex-agents/shared';
```

### Step 3: Add AgentConfigSchema to the import

Change line 20:
```typescript
import type { AgentBehaviorConfig } from '@dex-agents/shared';
```
to:
```typescript
import type { AgentBehaviorConfig } from '@dex-agents/shared';
import { AgentConfigSchema } from '@dex-agents/shared';
```

### Step 4: Replace raw cast with schema parse (line 84)

Replace:
```typescript
  const config = JSON.parse(agentRow.config) as {
    pairs: string[];
    dexes: string[];
    ...
  };
```

with:

```typescript
  let config: ReturnType<typeof AgentConfigSchema.parse>;
  try {
    config = AgentConfigSchema.parse(JSON.parse(agentRow.config));
  } catch (configErr) {
    console.error(`[agent-loop] ${agentId}: Invalid agent config in DB:`, configErr);
    return; // Skip this tick rather than crash with a confusing error
  }
```

### Step 5: Check AgentConfigSchema exports the right shape

Read `packages/shared/src/validation.ts` briefly to confirm it exports `AgentConfigSchema` and that the parsed type matches all fields used in `agent-loop.ts` (pairs, dexes, llmModel, autonomyLevel, etc.).

If the schema is missing fields used in agent-loop (e.g. `behavior`, `personaMd` comes from `agentRow` not config), adjust accordingly — do NOT add fields to the schema that don't belong there.

### Step 6: Build check

```bash
npm run build:worker 2>&1 | tail -20
```

Expected: no errors

### Step 7: Commit

```bash
git add apps/api/src/agents/agent-loop.ts
git commit -m "fix(agent-loop): validate agent config with AgentConfigSchema at runtime"
```

---

## Task 4: Enable SQLite FK enforcement

**Files:**
- Modify: `apps/api/src/agents/agent-loop.ts` and `apps/api/src/agents/manager-loop.ts`
- OR: create a shared db factory

**Approach:** The simplest approach is to run `PRAGMA foreign_keys = ON` immediately after creating the drizzle instance in each file. D1 doesn't support running this in migrations (it's session-level), so it must be set per-connection.

### Step 1: Add FK pragma in agent-loop.ts

In `runAgentLoop()`, after line 68 (`const db = drizzle(env.DB);`), add:

```typescript
  // Enable FK enforcement (must be set per connection in SQLite)
  try {
    await db.run(sql`PRAGMA foreign_keys = ON`);
  } catch { /* non-fatal: best effort */ }
```

Add `sql` to the drizzle-orm import at the top:
```typescript
import { drizzle } from 'drizzle-orm/d1';
import { eq, desc, sql } from 'drizzle-orm';
```

### Step 2: Add FK pragma in manager-loop.ts

Same pattern after line 451 (`const db = drizzle(env.DB);`):

```typescript
  try {
    await db.run(sql`PRAGMA foreign_keys = ON`);
  } catch { /* non-fatal */ }
```

Add `sql` to manager-loop.ts imports (line 9):
```typescript
import { eq, desc, inArray, sql } from 'drizzle-orm';
```

### Step 3: Build check

```bash
npm run build:worker 2>&1 | tail -20
```

### Step 4: Commit

```bash
git add apps/api/src/agents/agent-loop.ts apps/api/src/agents/manager-loop.ts
git commit -m "fix(db): enable PRAGMA foreign_keys = ON per connection in agent-loop and manager-loop"
```

---

## Task 5: Final build and push PR

### Step 1: Full clean build

```bash
npm run build:worker 2>&1
```

Expected: success

### Step 2: Push

```bash
git push origin fix/concurrency-minor
```

---

## Notes

- **Manager lock (Issue #5) is deferred.** Requires a DB migration, frontend changes, and careful semantics around what "user locked" means when the manager is stopped. The race is benign in most real-world usage (user and manager rarely conflict on the same agent simultaneously).
- The `_version` field in the PATCH body is optional — clients that don't send it are not affected. The frontend can start sending it to get conflict detection; existing clients that omit it continue to work as before.
- The FK pragma is best-effort (try/catch). If D1 doesn't support it in future runtimes, the catch silently swallows it. Explicit deletes in routes already handle cascades correctly.
