# PR 1: Trade Atomicity & Price Safety — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Prevent DO engine state and D1 from diverging on failed writes; prevent open positions from silently skipping SL/TP checks when price resolution fails.

**Architecture:**
- Add a `pendingTrade` key in DO storage (ctx.storage). Written before engine mutation, deleted after successful D1 persist. On each loop start, any pending trade is re-persisted (upsert is idempotent so safe to retry).
- Track consecutive price misses per open position in DO storage. After 3 misses, emit a critical log so the issue is visible.

**Tech Stack:** Cloudflare Durable Objects (ctx.storage), Drizzle D1 upsert, TypeScript

---

## Context

### File map
- `apps/api/src/agents/agent-loop.ts` — runAgentLoop(), persistTrade(), price resolution loop (lines 134–158, 458–498)
- `apps/api/src/agents/trading-agent.ts` — alarm(), close-position handler, persistTrade() duplicate (lines 225–278, 176–215, 348–383)

### Key invariants
- `persistTrade()` uses `onConflictDoUpdate` → re-persisting the same position is safe
- `engine.openPosition()` / `engine.stopOutPosition()` / `engine.closePosition()` all mutate in-memory state synchronously
- `ctx.storage` writes are durable (survive DO eviction)

---

## Task 1: Pending trade queue — open position

**Files:**
- Modify: `apps/api/src/agents/agent-loop.ts`

### Step 1: Add pending trade drain at start of runAgentLoop

In `runAgentLoop()`, after loading `agentRow` (line ~83), add a drain step before any new trades are executed.

Add this block after line 82 (`if (!options?.forceRun && agentRow.status !== 'running')`):

```typescript
// --- Drain any pending trade from a previous failed D1 write ---
const pendingTrade = await ctx.storage.get<Parameters<typeof persistTrade>[1]>('pendingTrade');
if (pendingTrade) {
  try {
    await persistTrade(db, pendingTrade);
    await ctx.storage.delete('pendingTrade');
    console.log(`[agent-loop] ${agentId}: Drained pending trade ${pendingTrade.id} to D1`);
  } catch (drainErr) {
    console.warn(`[agent-loop] ${agentId}: Failed to drain pending trade ${pendingTrade.id}:`, drainErr);
    // Leave pendingTrade in storage — will retry next tick
  }
}
// --- End drain ---
```

### Step 2: Wrap open-position path with pending trade guard

In the buy/sell execution block (around line 458–480), replace:

```typescript
    try {
      const position = engine.openPosition({
        ...
      });

      await persistTrade(db, position);
```

with:

```typescript
    try {
      // Compute position parameters before mutating engine state
      const openParams = {
        agentId,
        pair: targetPairName,
        dex: config.dexes[0] ?? 'aerodrome',
        side: decision.action as 'buy' | 'sell',
        price: pairData.priceUsd,
        amountUsd,
        maxPositionSizePct: config.maxPositionSizePct,
        balance: engine.balance,
        confidence: decision.confidence,
        reasoning: decision.reasoning,
        strategyUsed: config.strategies[0] ?? 'combined',
        slippagePct: config.slippageSimulation,
      };

      // Record intent BEFORE mutating engine state
      const position = engine.openPosition(openParams);
      await ctx.storage.put('pendingTrade', position);

      await persistTrade(db, position);
      await ctx.storage.delete('pendingTrade');
```

### Step 3: Wrap stop-loss/take-profit paths with pending trade guard

In the open-position loop (lines 134–158), replace:

```typescript
    if (engine.checkStopLoss(position, currentPrice, config.stopLossPct)) {
      const closed = engine.stopOutPosition(position.id, currentPrice);
      await persistTrade(db, closed);
```

with:

```typescript
    if (engine.checkStopLoss(position, currentPrice, config.stopLossPct)) {
      const closed = engine.stopOutPosition(position.id, currentPrice);
      await ctx.storage.put('pendingTrade', closed);
      await persistTrade(db, closed);
      await ctx.storage.delete('pendingTrade');
```

And similarly for take-profit:

```typescript
    if (engine.checkTakeProfit(position, currentPrice, config.takeProfitPct)) {
      const closed = engine.closePosition(position.id, {
        price: currentPrice,
        reason: 'Take profit triggered',
      });
      await ctx.storage.put('pendingTrade', closed);
      await persistTrade(db, closed);
      await ctx.storage.delete('pendingTrade');
```

And close-all path (lines 481–498):

```typescript
      const closed = engine.closePosition(position.id, {
        price: pairData.priceUsd,
        confidence: decision.confidence,
      });
      await ctx.storage.put('pendingTrade', closed);
      await persistTrade(db, closed);
      await ctx.storage.delete('pendingTrade');
```

### Step 4: Verify manually that type of pendingTrade matches Position

`persistTrade()` takes `Position`. `engine.openPosition()` etc. return `Position`. No type changes needed.

### Step 5: Commit

```bash
git add apps/api/src/agents/agent-loop.ts
git commit -m "fix(agent-loop): add pending trade queue to prevent engine/D1 state divergence"
```

---

## Task 2: Consecutive price miss tracking for open positions

**Files:**
- Modify: `apps/api/src/agents/agent-loop.ts` (price resolution loop, lines 134–158)

### Step 1: Add miss counter logic

Replace the silent `continue` on line 136:

```typescript
    if (currentPrice === 0) continue;
```

with:

```typescript
    if (currentPrice === 0) {
      const missKey = `priceMiss:${position.id}`;
      const misses = ((await ctx.storage.get<number>(missKey)) ?? 0) + 1;
      await ctx.storage.put(missKey, misses);
      if (misses >= 3) {
        console.error(
          `[agent-loop] ${agentId}: CRITICAL — price resolution failed ${misses} consecutive times for open position ${position.id} (${position.pair}). SL/TP checks skipped. Investigate GeckoTerminal/DexScreener availability.`
        );
      } else {
        console.warn(
          `[agent-loop] ${agentId}: Price resolution returned 0 for ${position.pair} (miss #${misses}). Skipping SL/TP check this tick.`
        );
      }
      continue;
    }
    // Reset miss counter on successful price resolution
    await ctx.storage.delete(`priceMiss:${position.id}`);
```

### Step 2: Clean up miss counters when position closes

In each place where a position is closed (stop-loss, take-profit, close-all, manual close), add cleanup after the D1 persist:

```typescript
      await ctx.storage.delete(`priceMiss:${position.id}`);
```

The three places in `agent-loop.ts`:
- After stop-loss `persistTrade` (line ~142)
- After take-profit `persistTrade` (line ~153)
- After close-all `persistTrade` (line ~491)

Also in `trading-agent.ts` `/close-position` handler, after `persistTrade` (line ~203):
```typescript
      await this.ctx.storage.delete(`priceMiss:${positionId}`);
```

### Step 3: Commit

```bash
git add apps/api/src/agents/agent-loop.ts apps/api/src/agents/trading-agent.ts
git commit -m "fix(agent-loop): track consecutive price misses for open positions and emit critical log"
```

---

## Task 3: Verify no regression in existing flow

### Step 1: Run build to check types compile

```bash
cd /path/to/heppy-market && npm run build:worker 2>&1 | tail -20
```

Expected: no TypeScript errors

### Step 2: Run existing tests

```bash
npm run test 2>&1 | tail -30
```

Expected: all pass (no tests exist for this path yet, so this just verifies nothing was broken)

### Step 3: Manual smoke test (local dev)

Start API locally:
```bash
npm run dev:api
```

1. Create and start an agent
2. Verify the agent loop runs without errors in console
3. Confirm no "pendingTrade drain" message appears on a clean start (means the key is absent as expected)

### Step 4: Final commit / push for PR

```bash
git push origin fix/trade-atomicity
```

---

## Notes

- `onConflictDoUpdate` in `persistTrade()` makes all retry attempts safe — no risk of duplicate records
- The `pendingTrade` key in DO storage will only ever hold ONE trade at a time (the most recent in-progress one). If agent opens multiple positions in one loop tick, each is written and cleared sequentially. This is safe because the loop is single-threaded within a DO.
- The miss counter keys are lightweight integers in DO storage; they are cleared on position close so there is no accumulation.
