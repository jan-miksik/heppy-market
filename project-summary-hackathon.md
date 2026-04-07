# initRoot – Hackathon Project Summary

## One-liner
initRoot is an edge-native, AI-assisted trading platform for DEX markets, where autonomous agents analyze market data, make structured decisions, and simulate trades with strong safety and auditability.

## What the project does
- Users create and manage AI trading agents with configurable strategy, risk limits, and persona.
- Agents run continuously on schedules, fetch DEX data, compute indicators, and request LLM-based trade decisions.
- The system executes paper trades (not real funds), tracks P&L, and shows trade/decision history in dashboards.
- Manager agents can orchestrate multiple trading agents.
- Real-time updates are delivered through WebSockets.

## Key innovation
- Edge-first autonomous architecture using Cloudflare Workers + Durable Objects as runtime source of truth.
- Safety-first AI loop:
  - Schema-validated LLM outputs
  - Idempotent execution rules
  - Retry/fallback behavior for external APIs and LLM calls
  - Rate limiting and secure session handling
- Built-in observability via decision logs, trade logs, and performance snapshots.

## Tech stack
- Frontend: Nuxt 4, Vue 3, TypeScript
- Backend: Hono on Cloudflare Workers
- Storage/state: D1, KV, Durable Objects, Cloudflare Queues
- AI layer: OpenRouter (optional Anthropic), structured outputs with schema validation

