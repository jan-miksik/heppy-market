# Agents Subsystem

- `agent-loop.ts`: top-level tick orchestration for one agent.
- `agent-loop/*`: focused helpers for market context, execution, and loop types.
- `trading-agent.ts`: compatibility export for the Durable Object entrypoint.
- `trading-agent/index.ts`: Durable Object entrypoint.
- `trading-agent/endpoint-*.ts`: request handlers split by inspection, control, and trade execution concerns.
- `manager-loop/*`: manager decision loop internals.

When adding logic, prefer helper modules under `agent-loop/` or dedicated files over expanding `agent-loop.ts` / `trading-agent.ts` directly.
