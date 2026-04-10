# Manager Detail Feature

This feature module handles the detailed view of a strategy manager.

## Entrypoint
- `useManagerDetailPage.ts`: Main composable containing business logic, data fetching, and state management.

## Components
- `ManagerHeaderSection.vue`: Page header and actions.
- `ManagerStatsSection.vue`: Information grid showing model, interval, and performance.
- `ManagerLogsSection.vue`: Decision history and reasoning logs.
- `ManagerAgentsSection.vue`: List of agents controlled by this manager.

## Data Flow
1. Page shell (`pages/managers/[id]/index.vue`) calls `init()` on the composable.
2. Composable fetches manager data, managed agents, decision logs, and token usage.
3. Polling (every 2s) refreshes status and detects cycle completion to reload logs/agents.
4. User actions (start/stop/trigger/delete) are handled through the composable.

## Related Tests
- (Add test references here once created)
