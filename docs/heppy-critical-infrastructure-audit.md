# Heppy Market — Critical Infrastructure Audit Checklist

> Use this file as a recurring audit instruction for Claude Code.
>
> Purpose: Identify system integrity, financial safety, and scalability risks.
>
> This is NOT a style review. This is a failure-risk audit.

---

# AUDIT ROLE

You are performing a **critical infrastructure audit** of the Heppy Market project.

This is an AI-driven trading agent platform built on:

* Cloudflare Workers
* Durable Objects
* Cloudflare D1 (SQLite)
* Cloudflare KV
* OpenRouter LLM
* External market APIs (DexScreener, etc.)

Focus ONLY on areas that could:

* Cause financial inconsistency
* Break state integrity
* Create race conditions
* Cause cascading failures
* Cause runaway costs
* Collapse under scale
* Create silent failures

Ignore cosmetic or stylistic issues.

---

# 1️⃣ Durable Object State Integrity

Audit all Durable Objects.

## Report:

* Any state mutation not protected by try/catch
* Any state mutation occurring AFTER external API call
* Any non-idempotent execution path
* Any missing execution_id or idempotency key
* Any possibility of duplicate alarm execution
* Any path where crash could leave partial state
* Any async call not awaited
* Any unbounded in-memory structure

## HIGH RISK if:

* Trade execution is not restart-safe
* Execution flow is not modeled as explicit state machine
* Alarm scheduling is unsafe

---

# 2️⃣ Trade Execution Atomicity

Audit trade execution flow.

## Report:

* Whether execution is idempotent
* Whether duplicate execution is possible
* Whether D1 writes are atomic
* Whether balance update and trade insert can desync
* Whether state transitions are deterministic
* Whether manager can modify agent mid-execution

## HIGH RISK if:

* Execution has no deterministic execution_id
* Writes happen in separate logical steps without safety guard

---

# 3️⃣ Alarm & Scheduling Safety

Audit alarm logic.

## Report:

* If alarms are synchronized (thundering herd risk)
* If jitter exists
* If next alarm scheduled before or after execution
* What happens if execution exceeds interval
* If alarm can fire twice
* If alarm rescheduling depends on successful execution

## HIGH RISK if:

* Alarm can create infinite loop
* Alarm can execute concurrently
* Alarm drift not logged

---

# 4️⃣ D1 Write & Query Risk

Audit all database interactions.

## Report:

* Missing indexes on high-volume queries
* Full table scans
* Unbounded queries
* Large payload writes
* Non-paginated endpoints
* High-frequency writes inside loops

## HIGH RISK if:

* Trade history not indexed by agent_id
* Decision log not indexed
* Snapshot updates not bounded

---

# 5️⃣ LLM Safety & Cost Explosion Risk

Audit LLM usage.

## Report:

* Whether schema validation enforced
* Whether timeout enforced
* Whether retries bounded
* Whether token usage logged
* Whether malformed JSON can break loop
* Whether LLM call happens inside critical state section

## HIGH RISK if:

* LLM output not validated
* LLM failure can corrupt state
* No daily usage limit

---

# 6️⃣ External API Risk (Dex & others)

Audit all external fetch calls.

## Report:

* Missing timeout
* Missing retry control
* No cache protection
* Possible thundering herd on cache expiry
* No fallback strategy

## HIGH RISK if:

* External API call can block execution
* No protection against 429 responses

---

# 7️⃣ Concurrency & Spam Risk

Audit all public endpoints.

## Report:

* Whether start/stop/reset endpoints are idempotent
* Whether user can spam start
* Whether multiple starts create multiple alarms
* Whether manager and user can conflict
* Whether agent reset safe during execution

## HIGH RISK if:

* Same agent can be started twice
* No protection against concurrent modifications

---

# 8️⃣ Runaway Resource Risk

Simulate mentally:

* 5,000 agents at 1m interval

Estimate:

* LLM calls/min
* D1 writes/min
* External API calls/min

## Report:

* First likely bottleneck
* Any unbounded growth mechanism
* Any risk of cost explosion

---

# 9️⃣ Silent Failure Risk

Audit logging and observability.

## Report:

* Whether every trade execution logs execution_id
* Whether alarm execution logged
* Whether LLM errors logged
* Whether DB failures logged
* Whether correlation ID exists

## HIGH RISK if:

* Any failure path returns silently
* Any catch block swallows error

---

# 🔟 Security & Secrets Risk

Audit security boundaries.

## Report:

* Secrets logging
* Unprotected admin routes
* CORS configuration
* Any public route that should be internal

---

# REQUIRED OUTPUT FORMAT (For Claude Code)

Respond with:

1. 🔴 HIGH RISK Issues (must fix before scale)
2. 🟠 MEDIUM Risk Issues
3. 🟢 Minor Observations
4. Architecture Weakness Summary
5. Scaling Weakness Summary
6. Top 5 Most Dangerous Areas

Do NOT suggest stylistic improvements.
Focus only on system integrity and financial safety.
