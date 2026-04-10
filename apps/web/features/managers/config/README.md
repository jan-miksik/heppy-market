# Manager Config Feature

Entry points:
- `components/ManagerConfigForm.vue`: form shell for create/edit manager flows.
- `features/managers/config/useManagerConfigForm.ts`: owns manager config state, auto-naming, persona generation, and prompt inputs.

State ownership:
- `useManagerConfigForm.ts` owns config defaults, behavior fields, persona markdown, and live prompt text.
- `components/config/*` and `components/manager-config/*` own bounded section rendering.

Change here first:
- Change manager defaults or prompt scaffolding in `useManagerConfigForm.ts`.
- Change section UI in the component layer.
- Avoid pushing manager-form orchestration back into the page shells.

Related tests:
- `packages/shared/src/profiles/manager-profiles.ts`
- `apps/api/tests/manager-loop.test.ts`
