1 Authentication & Access Control
Things to verify

Authentication must happen before business logic.

Checklist:

 Authentication middleware runs before all API routes

 All sensitive endpoints require authentication

 Tokens are validated for:

 signature

 expiration

 issuer

 API cannot be accessed without Pages proxy

 Worker rejects direct requests if accidentally exposed

 Tokens cannot be replayed

 Session expiration handled correctly

 CORS restrictions applied

Ask AI agent

Example prompt:

Analyze authentication in the API Worker.

Check:
- whether all protected endpoints enforce auth
- whether JWT verification checks expiration and signature
- whether any endpoint can bypass authentication
Manual test

Try:

curl /api/agents

Expected:

401 Unauthorized

Also test:

expired token

malformed token

missing token

2 Authorization

Authentication verifies who the user is.
Authorization verifies what they can do.

Checklist:

 User can access only their own agents

 Agent managers cannot control other users' agents

 Trade endpoints validate ownership

 Admin endpoints require admin role

 Resource IDs cannot be guessed to access other users

Ask AI
Scan all routes and verify that user ownership is checked
when accessing agents or trades.
3 Rate Limiting

Trading systems must prevent abuse.

Checklist:

 API rate limits per user or wallet

 Agent execution frequency limited

 Trade execution rate limited

 Rate limiting cannot be bypassed via multiple endpoints

 Rate limits enforced before expensive operations

Recommended implementation:

Durable Object per user
Manual stress test
for i in {1..200}; do curl /api/trade; done

Expected:

429 Too Many Requests
4 Durable Objects State Safety

Durable Objects manage agent state.

Checklist:

 Object IDs derived deterministically

 No race conditions in state updates

 State updates atomic

 Object state persisted correctly

 No unbounded memory growth

 DO instances handle restarts safely

Ask AI
Audit Durable Object code.

Check:
- race conditions
- inconsistent state updates
- possible deadlocks
5 Database Integrity (D1)

Database errors can break trading logic.

Checklist:

 All queries use parameterized inputs

 No SQL injection vulnerabilities

 Transactions used for critical updates

 Foreign key constraints enforced

 Schema migrations tracked

 No unbounded queries

Ask AI
Scan all D1 queries for SQL injection risks
and missing input validation.
6 Caching Safety

Edge caching can cause data leaks or stale data.

Checklist:

 Sensitive responses never cached

 Cache keys include user identity if needed

 TTL values appropriate

 Cache invalidation strategy exists

 No authentication tokens cached

Example mistake:

cacheKey = request.url

without including user ID.

7 Secrets Management

Secrets must never be exposed.

Checklist:

 All API keys stored in Worker secrets

 No secrets committed to Git

 No secrets logged

 Environment variables not leaked in responses

 Logs sanitized

Ask AI
Search codebase for possible secret leaks.
Look for API keys, private keys, tokens in logs.
8 Logging & Observability

Fintech apps must track all critical events.

Checklist:

 Trade execution logged

 Agent decisions logged

 Authentication failures logged

 Errors logged with stack traces

 Logs structured (JSON preferred)

 Logs do not contain sensitive data

Example good log:

{
  event: "trade_executed",
  agentId: "123",
  token: "ETH",
  size: 0.5
}
9 Cron Job Safety

Cron tasks must be idempotent.

Checklist:

 Cron tasks safe to run multiple times

 Cron failures handled

 No infinite loops

 Cron execution time monitored

 Duplicate execution does not cause duplicate trades

Ask AI
Analyze scheduled handlers.

Verify they are idempotent and safe if executed twice.
10 External API Safety

Your system calls external APIs:

price feeds

DEX data

AI models

Checklist:

 External API errors handled

 Timeouts implemented

 Retry logic limited

 Responses validated

 API keys not exposed

11 Worker Runtime Safety

Workers run in V8 isolates, which introduces constraints.

Checklist:

 No filesystem access assumed

 No Node-only APIs used

 CPU-heavy tasks avoided

 Worker memory usage limited

 Request timeout handled

12 API Surface Control

Make sure the Worker remains internal-only.

Checklist:

 Worker not publicly accessible

 Pages Service Binding required

 Direct Worker URL blocked

 Internal routing enforced

13 Error Handling

APIs must fail safely.

Checklist:

 All async code wrapped in try/catch

 Errors return safe responses

 Internal stack traces hidden

 Error logs include context

Example safe response:

{
  error: "internal_error"
}
14 AI Trading Safety

Because your system runs AI agents.

Checklist:

 AI outputs validated

 Max trade size enforced

 Invalid model outputs rejected

 Model failures handled

 Agents cannot trigger infinite trading loops

15 Performance

Workers must remain fast.

Checklist:

 Slow endpoints identified

 caching used where appropriate

 large responses streamed

 DB queries optimized