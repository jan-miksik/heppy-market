# Refactoring Plan

This document finalizes the repo-wide refactor plan for the original goal:

- make the codebase faster for humans and AI agents to navigate
- reduce token waste caused by mixed responsibilities and oversized files
- make ownership obvious from file paths
- keep future changes local instead of cross-cutting

It reflects the current repository state on 2026-04-10, not the earlier draft notes.

## Goal

A typical feature or bugfix should be solvable by opening a small, predictable set of files instead of scanning large route files, mixed orchestration modules, or duplicated helpers.

## Success Criteria

- Most feature work should require reading 1-5 files, not 10+.
- App-owned runtime files should usually stay below 250 LOC.
- 350 LOC is the review threshold.
- Route/page files should stay thin and compositional.
- Shared helpers should have one obvious source of truth.
- Tests should be named after modules or behavior, not historical phases.
- Each feature root or subsystem root should have a short README with entrypoints and change guidance.

## Current Verified Hotspots

The original highest-risk hotspots were closed out:

- `apps/api/src/agents/trading-agent.ts` is now a thin compatibility export
- `apps/api/src/services/llm-router.ts` is now a thin compatibility export
- `apps/api/src/services/coingecko-price.ts` is now a thin compatibility export
- `apps/api/src/agents/agent-loop/market.ts` is now a thin market-domain mapper

Files still above the preferred 250 LOC target, but below the 350 LOC review threshold:

- `apps/api/src/routes/auth.ts` (~302 LOC)
- `apps/api/src/routes/pairs.ts` (~291 LOC)

Those remaining route files now rely on shared helpers under `apps/api/src/routes/_shared/*`, so they are no longer the kind of mixed-responsibility blockers that motivated the original plan.

## Architecture Rules

- `pages/`
  - route params
  - page-level loading and error state
  - section composition
  - no heavy business orchestration
- `components/`
  - presentational sections
  - bounded smart panels
- `features/<domain>/<flow>/`
  - one obvious flow owner
  - one obvious entrypoint composable
  - one short README
- `services/`
  - external API access
  - provider clients
  - response normalization only when tightly coupled to provider data
- `routes/`
  - HTTP parsing and composition only
  - no embedded persistence or business logic when it can be extracted
- `repo/` or `*-repo.ts`
  - DB access only
- `*-schema.ts`
  - validation and DTO shaping only
- `*-types.ts`
  - shared types only

## Completed Work

### Phase 1: Frontend Page and Form Decomposition

Completed:

- Agent and manager detail pages were reduced to thinner route shells plus feature composables and section components.
- `AgentConfigForm.vue` and `ManagerConfigForm.vue` were decomposed around shared config sections.
- Frontend hotspots from the original plan are no longer priority refactor targets.

### Phase 2: Initia Bridge Split

Completed:

- The bridge surface is now organized around `apps/web/utils/initia/react-bridge.ts` plus focused helpers under `apps/web/utils/initia/bridge/*`.
- Frontend wallet and flow orchestration moved toward feature-level ownership instead of accumulating in the bridge runtime.

### Phase 3: Agent Loop Modularization

Completed enough for the original goal:

- `apps/api/src/agents/agent-loop/` contains focused modules such as `base-flow.ts`, `execution.ts`, `initia-perp.ts`, `llm-config.ts`, `market.ts`, `market-fetch.ts`, `queue.ts`, `risk-controls.ts`, and `types.ts`.
- `market.ts` now stays focused on decision-input shaping while fetch-heavy work lives in narrower helpers.

### Phase 4: Trading Durable Object Modularization

Completed:

- `apps/api/src/agents/trading-agent/index.ts`
- `apps/api/src/agents/trading-agent/state.ts`
- `apps/api/src/agents/trading-agent/alarms.ts`
- `apps/api/src/agents/trading-agent/websocket.ts`
- `apps/api/src/agents/trading-agent/cache.ts`
- `apps/api/src/agents/trading-agent/persistence.ts`
- request handlers split across:
  - `apps/api/src/agents/trading-agent/endpoints.ts`
  - `apps/api/src/agents/trading-agent/endpoint-control.ts`
  - `apps/api/src/agents/trading-agent/endpoint-inspection.ts`
  - `apps/api/src/agents/trading-agent/endpoint-trades.ts`

Verified outcome:

- the root Durable Object file is now a thin compatibility export
- runtime behavior is discoverable by filename
- request handling no longer shares one oversized module

### Phase 5: LLM Router Split

Completed:

- `apps/api/src/services/llm-router.ts` is now a thin export surface
- the implementation lives under:
  - `apps/api/src/services/llm-router/index.ts`
  - `apps/api/src/services/llm-router/provider-selection.ts`
  - `apps/api/src/services/llm-router/request-builders.ts`
  - `apps/api/src/services/llm-router/response-parsers.ts`
  - `apps/api/src/services/llm-router/types.ts`

### Phase 6: Market and Price Service Cleanup

Completed:

- `apps/api/src/services/coingecko-price.ts` is now a thin export surface
- provider-specific work lives under `apps/api/src/services/coingecko-price/*`
- cache keys and TTLs now have shared production sources under:
  - `apps/api/src/cache/keys.ts`
  - `apps/api/src/cache/ttl.ts`
- cache tests import production constants instead of copying literals

### Phase 7: Route Helper Unification

Completed:

- shared route helpers now exist under:
  - `apps/api/src/routes/_shared/owned-entity.ts`
  - `apps/api/src/routes/_shared/json-response.ts`
  - `apps/api/src/routes/_shared/parse-stored-json.ts`
  - `apps/api/src/routes/_shared/format-stored-entity.ts`
- `agents-route/shared.ts` and `managers-route/shared.ts` now reuse those helpers
- `auth.ts` and `pairs.ts` now consume the shared response layer

### Phase 8: Shared Auth, Cache, and Constants Surface

Completed:

- auth session entrypoint: `apps/api/src/auth/session.ts`
- cache constants: `apps/api/src/cache/ttl.ts`
- cache keys: `apps/api/src/cache/keys.ts`
- HTTP JSON responses: `apps/api/src/http/responses.ts`

### Phase 9: README and Navigation Layer

Completed:

- `apps/web/features/agents/create/README.md`
- `apps/web/features/agents/detail/README.md`
- `apps/web/features/agents/edit/README.md`
- `apps/web/features/agents/config/README.md`
- `apps/web/features/managers/detail/README.md`
- `apps/web/features/managers/config/README.md`
- `apps/web/utils/initia/README.md`
- `apps/api/src/agents/README.md`
- `apps/api/src/routes/README.md`
- `apps/api/src/services/README.md`

### Phase 10: Replace Phase-Style Tests

Completed:

- removed:
  - `apps/api/tests/phase1.test.ts`
  - `apps/api/tests/phase2.test.ts`
  - `apps/api/tests/phase3.test.ts`
  - `apps/api/tests/phase4.test.ts`
  - `apps/api/tests/phase6.test.ts`
- added behavior/module-named replacements:
  - `apps/api/tests/utilities-and-agent-config.test.ts`
  - `apps/api/tests/indicators-and-dex-data.test.ts`
  - `apps/api/tests/paper-engine.test.ts`
  - `apps/api/tests/interval-and-risk-controls.test.ts`
  - `apps/api/tests/snapshot-metrics-and-retry.test.ts`

## Verification

Verified on 2026-04-10:

- `pnpm --filter @something-in-loop/api build`
- `pnpm --filter @something-in-loop/api test`

Result:

- TypeScript build passed
- API test suite passed: 28 files, 379 tests passed, 1 skipped

## Remaining Work

No required work remains for the original refactoring goal.

Optional follow-up only:

- if desired, split `apps/api/src/routes/auth.ts` and `apps/api/src/routes/pairs.ts` further to get them below the preferred 250 LOC target, even though both are already below the 350 LOC review threshold and now sit on shared helper surfaces
- `apps/api/tests/managers-route-utils.test.ts`
- `apps/api/tests/pairs-normalization.test.ts`

Rules:

- tests should be named after modules or behavior
- tests should import production constants and helpers where possible
- duplicated cache-key logic should be removed
- duplicated prompt-schema logic should be removed
- no new phase-style names

Expected outcome:

- tests become a navigation tool instead of historical baggage

## Phase 11: Repo Hygiene Automation

Priority: medium

Add lightweight checks that prevent structural drift.

Suggested checks:

- warn on app-owned files above 250 LOC
- fail on app-owned files above 350 LOC for selected directories after migration
- require README presence in declared feature roots
- detect duplicated banned symbols or duplicated local helper implementations
- optionally enforce import boundaries in selected directories

Suggested scripts:

- `scripts/check-file-sizes.mjs`
- `scripts/check-feature-readmes.mjs`
- `scripts/check-duplicate-symbols.mjs`

Expected outcome:

- the repo does not slide back into large-file sprawl after cleanup

## Phase 12: Export Surface Cleanup

Priority: lower

Review barrels and public export boundaries.

Rules:

- allow barrels at subsystem boundaries
- avoid broad global barrels that hide ownership
- avoid `index.ts` files that mix unrelated domains

Likely review targets:

- `packages/shared/src/index.ts`
- any oversized `index.ts` that exports unrelated areas together

Expected outcome:

- ownership stays visible from import paths

## Recommended Execution Order

1. Split `apps/api/src/agents/trading-agent.ts`.
2. Split `apps/api/src/services/llm-router.ts`.
3. Split `apps/api/src/services/coingecko-price.ts` and tighten `apps/api/src/agents/agent-loop/market.ts`.
4. Unify shared route helpers across `routes/*`.
5. Replace phase-style tests with module-aligned tests.
6. Add missing subsystem READMEs.
7. Add hygiene scripts and enforce thresholds gradually.
8. Review export surfaces last.

## Definition Of Done

This refactor is complete only when:

- the current backend hotspots are either split or reduced below agreed thresholds
- Durable Object, route, and service boundaries are explicit from file names
- shared auth, cache, and HTTP helpers have one obvious source of truth
- required feature and subsystem READMEs exist
- phase-style tests are removed or renamed by ownership
- lightweight structural hygiene checks are in place

## Notes

- Preserve public behavior while changing internal structure.
- Prefer extracting cohesive units over large mechanical rewrites.
- When in doubt, optimize for discoverability over clever abstraction.
