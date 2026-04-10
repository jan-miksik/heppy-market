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

These are the main files still worth splitting or tightening:

- `apps/api/src/agents/trading-agent.ts` (~632 LOC)
- `apps/api/src/services/llm-router.ts` (~551 LOC)
- `apps/api/src/services/coingecko-price.ts` (~437 LOC)
- `apps/api/src/agents/agent-loop/market.ts` (~395 LOC)
- `apps/api/src/routes/auth.ts` (~313 LOC)
- `apps/api/src/routes/pairs.ts` (~284 LOC)

Frontend files previously flagged as hotspots are now below the review threshold:

- `apps/web/pages/agents/[id]/index.vue` (~185 LOC)
- `apps/web/components/AgentConfigForm.vue` (~149 LOC)
- `apps/web/components/ManagerConfigForm.vue` (~119 LOC)
- `apps/web/utils/initia/react-bridge.ts` (~166 LOC)

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

### Phase 3: Partial Agent Loop Modularization

Partially completed:

- `apps/api/src/agents/agent-loop/` already contains focused modules such as `base-flow.ts`, `execution.ts`, `initia-perp.ts`, `llm-config.ts`, `market.ts`, `queue.ts`, `risk-controls.ts`, and `types.ts`.
- This means the agent-loop refactor has started, but the remaining boundary work should focus on the files that still mix multiple concerns.

## Remaining Work

## Phase 4: Trading Durable Object Modularization

Priority: highest

Primary target:

- `apps/api/src/agents/trading-agent.ts`

Target structure:

- `apps/api/src/agents/trading-agent/index.ts`
- `apps/api/src/agents/trading-agent/state.ts`
- `apps/api/src/agents/trading-agent/alarms.ts`
- `apps/api/src/agents/trading-agent/websocket.ts`
- `apps/api/src/agents/trading-agent/cache.ts`
- `apps/api/src/agents/trading-agent/endpoints.ts`
- keep `apps/api/src/agents/trading-agent/persistence.ts` aligned with the new boundary

Expected outcome:

- transport, state, scheduling, and request handling stop living in one file
- Durable Object behavior becomes discoverable by filename
- tests can target narrower runtime units

## Phase 5: LLM Router Split

Priority: highest

Primary target:

- `apps/api/src/services/llm-router.ts`

Target structure:

- `apps/api/src/services/llm-router/index.ts`
- `apps/api/src/services/llm-router/provider-selection.ts`
- `apps/api/src/services/llm-router/request-builders.ts`
- `apps/api/src/services/llm-router/response-parsers.ts`
- `apps/api/src/services/llm-router/schema-instructions.ts` only if it remains meaningfully separate

Expected outcome:

- provider selection, prompt construction, and response parsing are no longer interleaved
- adding a provider or changing schema instructions becomes a local change

## Phase 6: Market and Price Service Cleanup

Priority: high

Primary targets:

- `apps/api/src/services/coingecko-price.ts`
- `apps/api/src/agents/agent-loop/market.ts`

Split by concern:

- fetch client
- cache keys and TTL constants
- response normalization
- market-domain mapping
- agent-loop decision input shaping

Expected outcome:

- provider replacement becomes tractable
- normalization becomes directly testable
- cache behavior stops being duplicated

## Phase 7: Route Helper Unification

Priority: medium-high

Primary targets:

- `apps/api/src/routes/auth.ts`
- `apps/api/src/routes/pairs.ts`
- shared helpers currently spread across `agents-route/*`, `managers-route/*`, and route-local utilities

Suggested shared layout:

- `apps/api/src/routes/_shared/owned-entity.ts`
- `apps/api/src/routes/_shared/json-response.ts`
- `apps/api/src/routes/_shared/parse-stored-json.ts`
- `apps/api/src/routes/_shared/format-stored-entity.ts`

Likely shared helpers:

- `withOwnedEntity`
- `parseStoredJson`
- `formatStoredEntity`
- `notFoundJson`

Expected outcome:

- route handlers become shorter and more uniform
- the same route pattern is reused across agents, managers, and general endpoints

## Phase 8: Shared Auth, Cache, and Constants Surface

Priority: medium-high

Current state:

- auth already has a partial subsystem under `apps/api/src/lib/auth/*`
- cache keys and TTL values are still worth consolidating if duplicated across services or tests

Candidate modules:

- `apps/api/src/auth/session.ts` or continue consolidating under `apps/api/src/lib/auth/*`
- `apps/api/src/cache/keys.ts`
- `apps/api/src/cache/ttl.ts`
- `apps/api/src/http/responses.ts`

Expected outcome:

- tests import production constants instead of copying them
- operational values have a single source of truth

## Phase 9: README and Navigation Layer

Priority: medium

Goal:

- every important feature or subsystem root should explain entrypoints, data flow, and where to edit first

Verified current status:

- done: `apps/web/features/agents/create/README.md`
- missing: `apps/web/features/agents/detail/README.md`
- missing: `apps/web/features/agents/edit/README.md`
- missing: `apps/web/features/agents/config/README.md`
- done: `apps/web/features/managers/detail/README.md`
- missing: `apps/web/features/managers/config/README.md`
- done: `apps/web/utils/initia/README.md`
- done: `apps/api/src/agents/README.md`
- done: `apps/api/src/routes/README.md`
- missing: `apps/api/src/services/README.md`

Each README should answer:

- what is the entrypoint
- what owns state
- where behavior should be changed first
- which related tests matter
- which large file should not be edited first if a narrower module exists

## Phase 10: Replace Phase-Style Tests

Priority: medium

Phase-style files still present:

- `apps/api/tests/phase1.test.ts`
- `apps/api/tests/phase2.test.ts`
- `apps/api/tests/phase3.test.ts`
- `apps/api/tests/phase4.test.ts`
- `apps/api/tests/phase6.test.ts`

Good examples already present:

- `apps/api/tests/coingecko-price.test.ts`
- `apps/api/tests/manager-loop.test.ts`
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
