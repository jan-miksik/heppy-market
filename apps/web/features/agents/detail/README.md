# Agent Detail Feature

Entry points:
- `pages/agents/[id]/index.vue`: route shell and section composition only.
- `features/agents/detail/useAgentDetailPage.ts`: owns page loading, polling, actions, and error state.

State ownership:
- `useAgentDetailPage.ts` owns fetched agent data, trades, decisions, snapshots, realtime status, and action lifecycles.
- `components/agent-detail/*` own bounded presentation for each section.

Change here first:
- Change fetch/poll/action behavior in `useAgentDetailPage.ts`.
- Change section layout or rendering in `components/agent-detail/*`.
- Avoid adding more orchestration directly to the page shell if the composable already owns the flow.

Related tests:
- `apps/web/tests/statusPolling.test.ts`
- `apps/api/tests/manager-loop.test.ts`
- `apps/api/tests/realtime.test.ts`
