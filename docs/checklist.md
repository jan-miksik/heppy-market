🧠 1. Durable Object Integrity Audit

This is your most critical layer.

✅ Things To Check

 Is every state transition explicit?
 Is there a defined state machine for trade execution?
 Are all writes inside try/catch?
 Is restart safety guaranteed?
 Can duplicate alarms happen?
 Can two requests race inside same DO?
 Is any external call made before state is persisted?
 Is there idempotency key for execution?

🧪 Practical Tasks

Simulate DO crash mid execution (throw manually)
Simulate duplicate alarm
Simulate rapid start/stop spam
Force timeout in LLM call
Then inspect state consistency.
If state can be corrupted → redesign.

🧠 2. Alarm & Scheduling Hardening

You currently have potential thundering herd risk.

✅ Check

 Are alarms jittered?
 Is next alarm scheduled before or after execution?
 What happens if execution exceeds interval?
 Is alarm re-entrant safe?
 Can alarm fire twice due to retry?

🧪 Exercise

Add random jitter (0–10s).
Then simulate 1,000 agents.
Observe execution distribution in logs.

🧠 3. D1 Database Hardening

Cloudflare D1 is SQLite-based.

It will be your first scaling bottleneck.

✅ Check

 Are all critical reads done inside DO instead of D1?

 Are write operations batched?

 Are indexes defined for:

trades.agent_id

trades.created_at

agent_decisions.agent_id

 Is pagination implemented?

 Any full table scans?

🧪 Exercise

Simulate:

500k trades in table

Run trade history query

Check latency.

If > 100ms → fix index.

🧠 4. LLM Safety & Stability

This is your most unpredictable dependency.

✅ Check

 All outputs schema validated (Zod)

 Timeout enforced

 Retries limited

 Latency logged

 Token usage logged

 Decision logged BEFORE execution

 Can malformed JSON break loop?

🧪 Exercise

Force LLM to:

Return invalid JSON

Timeout

Return hold 100 times

Return 100% position size

System must remain stable.

🧠 5. External API Hardening (Dex)

Your Dex data can cause herd effects.

✅ Check

 KV cache TTL?

 Cache key normalization?

 Protection against cache stampede?

 Timeout on fetch?

 Fallback data handling?

🧪 Exercise

Simulate:

Dex returns 500

Dex returns stale data

Dex returns malformed data

What happens to agents?

🧠 6. Concurrency & Idempotency

Financial systems die here.

✅ Check

 Is trade execution idempotent?

 Is execution ID deterministic?

 Can user spam start/stop?

 Is reset safe during active execution?

 Can manager modify agent mid execution?

🧪 Exercise

Send 100 concurrent:

POST /api/agents/:id/start

Does anything duplicate?
Does state become inconsistent?

🧠 7. Abuse & Rate Limiting

If this goes public, abuse is guaranteed.

✅ Check

 Rate limit per IP?

 Rate limit per user?

 Limit max agents per user?

 Limit max LLM calls per day?

 Prevent 10k agents creation?

🧠 8. Observability Layer

If you cannot trace, you do not own it.

✅ Check

 Every request has correlation ID?

 Every trade execution logs execution_id?

 Can you trace one trade fully?

 Do you log latency distribution?

 Can you detect alarm drift?

🧪 Exercise

Pick one trade.
Trace:

Alarm fired

LLM decision

Execution

D1 insert

Snapshot update

If not trivial → improve logging.

🧠 9. Scaling Simulation

Now the serious part.

Simulate mentally:

1,000 agents @ 1m

5,000 agents @ 1m

10,000 agents @ 5m

Estimate:

D1 writes/min

LLM calls/min

Dex calls/min

If numbers scare you → redesign architecture.

🧠 10. Codebase Maintainability

AI-generated code becomes messy fast.

✅ Check

 Is business logic inside services, not routes?

 Is DO logic separated from pure logic?

 Are prompts centralized?

 Is config validated once?

 Are types shared properly via packages/shared?

 Are magic numbers removed?

🧪 Use Claude for:

Refactor to isolate domain logic from Cloudflare bindings.

That improves portability long-term.

🧠 11. Secrets & Security
✅ Check

 Are secrets only in Workers env?

 Is no secret logged?

 Are CORS rules strict?

 Are admin endpoints protected?

 Are internal routes inaccessible?

🧠 12. Manager DO Hardening

Your manager is meta-controller.

✅ Check

 Can manager create infinite agents?

 Is manager decision idempotent?

 Can manager conflict with user edits?

 Is manager memory bounded?

 Is manager decision logged before action?