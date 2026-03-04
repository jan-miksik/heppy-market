# PR 2: Scheduling Reliability & LLM Safety — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add jitter to alarm scheduling to prevent thundering herd; add a timeout to the manager LLM call (currently unguarded); reduce timeout for emergency fallback models to prevent long stalls.

**Architecture:**
- Jitter: ±15% random offset applied to `nextAlarmAt` in `intervalToMs()` call sites. Small enough to not skew intervals significantly, large enough to desynchronize mass-started agents.
- Manager timeout: wrap `generateText()` in `manager-loop.ts` with the same `Promise.race()` pattern already used in `llm-router.ts`.
- Emergency model timeout: pass a shorter `timeoutMs` (30s) when trying emergency fallback models in `llm-router.ts`.

**Important pre-read:** The cron fallback in `index.ts` (lines 149–205) already handles DO eviction — it calls `/analyze` on all running agents at each matching interval, which implicitly reschedules the alarm via `rescheduleAlarmIfRunning()`. **No new cron trigger is needed.** The alarm scheduling gap risk is already mitigated.

**Tech Stack:** Cloudflare Workers, Cloudflare Durable Objects, TypeScript

---

## Context

### File map
- `apps/api/src/agents/trading-agent.ts:267–277` — alarm finally block where `setAlarm()` is called
- `apps/api/src/agents/trading-agent.ts:281–293` — `rescheduleAlarmIfRunning()` helper
- `apps/api/src/agents/trading-agent.ts:87–91` — `/start` handler where first alarm is scheduled
- `apps/api/src/agents/manager-loop.ts:576–591` — manager `generateText()` call (no timeout)
- `apps/api/src/services/llm-router.ts:82,107,143–196` — `getTradeDecision()` with `timeoutMs` and model loop

---

## Task 1: Add jitter to alarm scheduling in TradingAgentDO

**Files:**
- Modify: `apps/api/src/agents/trading-agent.ts`

### Step 1: Add jitter helper function

Add after the existing `intervalToMs()` function (after line 23):

```typescript
/**
 * Apply ±15% random jitter to a millisecond interval.
 * Prevents thundering herd when many agents share the same analysis interval.
 */
function addJitter(ms: number): number {
  const jitterFraction = 0.15;
  const jitter = ms * jitterFraction * (Math.random() * 2 - 1); // -15% to +15%
  return Math.round(ms + jitter);
}
```

### Step 2: Apply jitter in alarm finally block (line ~270)

In the `alarm()` method finally block, change:

```typescript
          const nextAlarmAt = Date.now() + intervalToMs(interval);
```

to:

```typescript
          const nextAlarmAt = Date.now() + addJitter(intervalToMs(interval));
```

### Step 3: Apply jitter in rescheduleAlarmIfRunning (line ~286)

In `rescheduleAlarmIfRunning()`, change:

```typescript
        const nextAlarmAt = Date.now() + intervalToMs(interval);
```

to:

```typescript
        const nextAlarmAt = Date.now() + addJitter(intervalToMs(interval));
```

### Step 4: Do NOT apply jitter on /start first tick

The `/start` handler (line 88) uses `Math.min(5_000, intervalMs)` for the first tick — this is intentional (quick first run). Leave it unchanged.

### Step 5: Commit

```bash
git add apps/api/src/agents/trading-agent.ts
git commit -m "fix(trading-agent): add ±15% jitter to alarm scheduling to prevent thundering herd"
```

---

## Task 2: Add timeout to manager LLM call

**Files:**
- Modify: `apps/api/src/agents/manager-loop.ts`

### Step 1: Add timeout constant near top of file

After the imports section (after line ~19), add:

```typescript
const MANAGER_LLM_TIMEOUT_MS = 60_000; // 60s — generous for manager's larger prompt
```

### Step 2: Wrap generateText call in Promise.race

In `runManagerLoop()`, replace the `generateText()` call (lines ~576–583):

```typescript
      const result = await generateText({
        model: openrouter(config.llmModel),
        messages: [{ role: 'user', content: prompt }],
        temperature: config.temperature,
        maxOutputTokens: 2048,
      });
      rawResponse = result.text;
```

with:

```typescript
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`Manager LLM timed out after ${MANAGER_LLM_TIMEOUT_MS / 1000}s`)),
          MANAGER_LLM_TIMEOUT_MS
        )
      );
      const result = await Promise.race([
        generateText({
          model: openrouter(config.llmModel),
          messages: [{ role: 'user', content: prompt }],
          temperature: config.temperature,
          maxOutputTokens: 2048,
        }),
        timeoutPromise,
      ]);
      rawResponse = result.text;
```

### Step 3: Verify the catch block already handles the timeout error

Lines ~587–590 already catch any error from this block:

```typescript
    } catch (err) {
      console.error(`[manager-loop] ${managerId}: LLM error:`, err);
      rawResponse = JSON.stringify([{ action: 'hold', reasoning: `LLM error: ${String(err)}` }]);
    }
```

Timeout rejection will be caught here → manager defaults to hold. No change needed.

### Step 4: Commit

```bash
git add apps/api/src/agents/manager-loop.ts
git commit -m "fix(manager-loop): add 60s timeout to manager LLM call to prevent indefinite stall"
```

---

## Task 3: Shorter timeout for emergency fallback models in llm-router

**Files:**
- Modify: `apps/api/src/services/llm-router.ts`

### Step 1: Add emergency timeout constant

After line 82 (`const DEFAULT_LLM_TIMEOUT_MS = 90_000;`), add:

```typescript
/** Shorter timeout used for emergency fallback models (lower quality bar, faster fail) */
const EMERGENCY_MODEL_TIMEOUT_MS = 30_000;
```

### Step 2: Determine which models are "emergency"

In `getTradeDecision()`, the `modelsToTry` array is built as:
1. `config.model` (primary)
2. `config.fallbackModel` (user-configured fallback, if enabled)
3. `EMERGENCY_FREE_MODELS` (emergency chain, if `allowFallback` enabled)

We need to apply the shorter timeout when iterating the emergency models. The cleanest approach: track whether the current model is an emergency model.

Replace the `modelsToTry` array build block (lines ~120–128) with:

```typescript
  const primaryModels: string[] = [config.model];
  if (config.allowFallback && config.fallbackModel && config.fallbackModel !== config.model) {
    primaryModels.push(config.fallbackModel);
  }
  const emergencyModels: string[] = [];
  if (config.allowFallback) {
    for (const m of EMERGENCY_FREE_MODELS) {
      if (!primaryModels.includes(m)) emergencyModels.push(m);
    }
  }
  const modelsToTry = [...primaryModels, ...emergencyModels];
  const primaryModelSet = new Set(primaryModels);
```

### Step 3: Use correct timeout per model in the loop

In the loop body (around line 145), replace:

```typescript
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`Model request timed out after ${timeoutMs / 1000}s`)),
          timeoutMs
        )
      );
```

with:

```typescript
      const effectiveTimeout = primaryModelSet.has(modelId) ? timeoutMs : EMERGENCY_MODEL_TIMEOUT_MS;
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`Model request timed out after ${effectiveTimeout / 1000}s`)),
          effectiveTimeout
        )
      );
```

### Step 4: Build to check types

```bash
npm run build:worker 2>&1 | tail -20
```

Expected: no errors

### Step 5: Commit

```bash
git add apps/api/src/services/llm-router.ts
git commit -m "fix(llm-router): reduce emergency model timeout to 30s (vs 90s for primary)"
```

---

## Task 4: Verify full build and push PR

### Step 1: Final build check

```bash
npm run build:worker 2>&1
```

Expected: success, no TypeScript errors

### Step 2: Push

```bash
git push origin fix/scheduling-llm
```
