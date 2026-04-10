# Agent Config Feature

Entry points:
- `components/AgentConfigForm.vue`: form shell and submit diffing for edit mode.
- `features/agents/config/useAgentConfigForm.ts`: owns form defaults, profile/persona behavior, and submit payload shaping.

State ownership:
- `useAgentConfigForm.ts` owns config form state, profile selection, persona markdown, and model availability logic.
- `components/config/*` own bounded section UI only.

Change here first:
- Change defaults, derived fields, or payload shaping in `useAgentConfigForm.ts`.
- Change section rendering in `components/config/*`.
- Avoid editing pages first when the behavior is really form-local.

Related tests:
- `packages/shared/src/validation.test.ts`
- `apps/api/tests/agent-config.test.ts`
