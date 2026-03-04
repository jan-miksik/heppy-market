  ---                                                                                                                          
  Critical Infrastructure Audit — Heppy Market                                                                                 
                                                                                                                               
  ---                                                                                                                          
  🔴 HIGH RISK Issues (must fix before scale)                                                                                  
                                                                                                                               
  1. Trade State / D1 Divergence                                                                                               

  agent-loop.ts / paper-engine.ts

  PaperEngine mutates in-memory balance before D1 write. If D1 write fails after ctx.storage.put() serializes the engine, the
  position exists in DO memory but has no DB record. The agent continues with a phantom balance loss; the UI shows no open
  position.

  Engine state: balance = $5,000, position in openPositions ✓
  D1 write fails ✗
  → Agent loops using $5,000 balance, DB has no trade row

  No retry, no pending-trade queue. The current catch block only logs a warning and continues.

  Fix: Add a pendingTrades list in DO storage. Persist it before modifying engine state. On engine deserialize, replay any
  pending entries before resuming the loop.

  ---
  2. Alarm Scheduling Gap on DO Eviction

  trading-agent.ts

  The finally block correctly reschedules the alarm on exception, but Cloudflare evicts DOs after inactivity. If the DO is
  evicted mid-execution, finally may not run. The self-heal in /status only fires when a user opens the UI. An agent running
  without UI polling can stall silently indefinitely.

  Fix: Add a Worker Cron Trigger that runs every 5 minutes and queries all agents with status='running' and nextAlarmAt < now -
   30s, then calls setAlarm() on their DOs.

  ---
  🟠 MEDIUM Risk Issues

  3. N+1 Queries in Manager Loop

  manager-loop.ts

  For each managed agent, the loop issues 2 separate D1 queries (latest snapshot + recent trades). With 100 agents this is 200+
   queries per cycle, well above D1 free-tier limits under load.

  Fix: Batch with inArray() and group results in memory.

  ---
  4. LLM JSON Extraction Fragile

  llm-router.ts

  extractJson() uses indexOf('{') / lastIndexOf('}') which can span multiple JSON objects or grab the wrong one if the
  reasoning section contains braces before the decision JSON. Failed parses default to hold — safe but silent. The raw response
   is not logged when this happens.

  Fix: Log the first 200 chars of raw output on parse failure. Consider iterating candidate JSON boundaries rather than
  trusting first/last brace.

  ---
  5. Manager Can Override User's Manual Stop

  manager-loop.ts / agents.ts

  Manager's start_agent action calls the DO /start and sets DB status='running', even if the user just paused the agent via UI.
   There is no lock or flag to signal "user override in progress."

  Fix: Add a userLocked boolean column. If set, manager skips actions on that agent.

  ---
  6. Open Position Price Silently Skipped on API Failure

  agent-loop.ts

  When resolveCurrentPriceUsd() returns 0 for an open position, the loop silently continues. Stop-loss and take-profit checks
  are skipped. The agent holds the position forever without knowing it cannot price it.

  Fix: Log a warning per position. After N consecutive misses, close the position at the last known price with a "price
  unavailable" reason.

  ---
  7. Concurrent Config Writes — No Optimistic Locking

  agents.ts PATCH endpoint

  Two simultaneous PATCH requests both read the same config blob, merge their own changes, and write back. The second write
  silently overwrites the first. Low probability for single-user agents, but the pattern is wrong.

  Fix: Add an updatedAt version field. Reject if the version in the request doesn't match the DB version.

  ---
  8. LLM Timeout 90s — Cumulative Stall Risk

  llm-router.ts

  With 8 models in the fallback chain × 90s timeout, worst-case stall is 12 minutes per agent loop cycle. The alarm
  rescheduling only happens after the loop returns, so all other agents on the same DO instance (if co-located) wait.

  Fix: Lower timeout for emergency fallback models to 20–30s. Cache which models are currently failing and skip them for 5
  minutes.

  ---
  🟢 Minor Observations

  - FK enforcement disabled: SQLite FKs are off by default in D1. Explicit deletes (delete trades where agentId=X before agent
  delete) compensate correctly, but PRAGMA foreign_keys = ON per connection would add defense-in-depth.
  - Legacy unowned agents: requireOwnership() passes through agents with ownerAddress = NULL, allowing any authenticated user
  to modify them. One-time migration: UPDATE agents SET owner_address = '0x...' WHERE owner_address IS NULL.
  - Nonce replay on KV delete failure: If cache.delete(nonce:...) fails after signature verification, the nonce remains valid
  for replay. Add a max-age check (reject nonces older than 5 minutes regardless of KV state).
  - Session TTL 7 days: Standard for consumer apps, but high for a financial tool. Consider 24–48h.
  - Agent config not runtime-validated: JSON.parse(agentRow.config) as {...} casts without schema validation.
  AgentConfigSchema.parse() from packages/shared is already available—use it here.

  ---
  Architecture Weakness Summary

  The architecture is DO-centric with no distributed transaction primitive. D1 writes are "best effort" from the perspective of
   the DO — if they fail, the DO's in-memory state (serialized to ctx.storage) and the DB diverge with no reconciliation path.
  This is the largest structural weakness: the system has strong eventual consistency assumptions but treats writes as atomic.

  The multi-tier LLM fallback and price-source fallback chains are solid. The alarm lifecycle pattern (finally-block reschedule
   + status self-heal) is well-designed but has the DO eviction gap.

  ---
  Scaling Weakness Summary

  ┌─────────────────────────────────────────────┬─────────────────────────────────────────────────────────┐
  │                 Load Point                  │                          Risk                           │
  ├─────────────────────────────────────────────┼─────────────────────────────────────────────────────────┤
  │ 5,000 agents × 1m interval                  │ 5,000 LLM calls/min → OpenRouter rate limit             │
  ├─────────────────────────────────────────────┼─────────────────────────────────────────────────────────┤
  │ Manager N+1 queries                         │ 200+ D1 queries/cycle → D1 rate limit at ~50+ agents    │
  ├─────────────────────────────────────────────┼─────────────────────────────────────────────────────────┤
  │ All agents share same DexScreener endpoints │ Thundering herd on cache expiry                         │
  ├─────────────────────────────────────────────┼─────────────────────────────────────────────────────────┤
  │ All alarms at same wall-clock offset        │ Synchronized thundering herd if agents started in batch │
  └─────────────────────────────────────────────┴─────────────────────────────────────────────────────────┘

  No jitter is added to alarm scheduling. If 1,000 agents are started at the same time, they fire every interval in lockstep.
  Add ±10–30% random jitter to nextAlarmAt.

  ---
  Top 5 Most Dangerous Areas

  ┌──────┬─────────────────────────────┬────────────────────────────────────────────────────────────────────┐
  │ Rank │            Area             │                                Why                                 │
  ├──────┼─────────────────────────────┼────────────────────────────────────────────────────────────────────┤
  │ 1    │ Trade state / D1 divergence │ Balance and position state can diverge silently; no reconciliation │
  ├──────┼─────────────────────────────┼────────────────────────────────────────────────────────────────────┤
  │ 2    │ Alarm gap on DO eviction    │ Agents can stop trading silently with no alert                     │
  ├──────┼─────────────────────────────┼────────────────────────────────────────────────────────────────────┤
  │ 3    │ Open position price skip    │ Stop-loss never triggers on failed price fetch; unlimited downside │
  ├──────┼─────────────────────────────┼────────────────────────────────────────────────────────────────────┤
  │ 4    │ Manager overrides user stop │ User loses control of their own agent without visibility           │
  ├──────┼─────────────────────────────┼────────────────────────────────────────────────────────────────────┤
  │ 5    │ N+1 D1 queries in manager   │ Hard rate-limit failure at moderate fleet size                     │