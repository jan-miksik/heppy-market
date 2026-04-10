# Agent Edit Flow

Current entry points:
- `pages/agents/[id]/edit.vue`: route shell for loading existing agent data and wiring save/cancel behavior.
- `components/AgentConfigForm.vue`: shared create/edit form surface.
- `components/AgentPromptPreviewPanel.vue`: prompt preview panel shared with create flow.

State ownership:
- The route owns existing-agent fetch, save lifecycle, and prompt-preview bootstrap.
- `useAgentConfigForm.ts` under `features/agents/config/` owns editable form state.

Change here first:
- Change edit-page loading or save flow in `pages/agents/[id]/edit.vue`.
- Change reusable config behavior in `features/agents/config/useAgentConfigForm.ts`.
- Do not create edit-only business logic inside the shared form unless it is genuinely shared.

Related tests:
- `apps/api/tests/agent-config.test.ts`
