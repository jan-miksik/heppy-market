# Codex Audit

Date: 2026-04-15

Scope:
- Static review of `apps/api`, `apps/web`, and shared package boundaries
- Validation via existing test suites

Validation run:
- `pnpm --filter @something-in-loop/api test` ✅
- `pnpm --filter @something-in-loop/web test` ✅
- `pnpm --filter @something-in-loop/shared test` ✅
- `pnpm --filter @something-in-loop/api build` ✅
- `pnpm --filter @something-in-loop/web lint` ✅

## Findings

### 1. High: `hackathon-session` can be enabled by client-controlled headers and creates sessions without proof of wallet ownership

Files:
- `apps/api/src/routes/auth.ts:83`
- `apps/api/src/routes/auth.ts:88`
- `apps/api/src/routes/auth.ts:132`

Why this matters:
- `isHackathonBypassAllowed()` treats `Origin` and `Referer` as trust signals for localhost mode.
- Those headers are request metadata, not a trustworthy deployment/environment check.
- When this branch is reachable, `POST /api/auth/hackathon-session` mints a real authenticated session for any submitted wallet address without a signature challenge.

What should change:
- Remove `Origin`/`Referer` based bypassing entirely.
- Gate the route only on an explicit server-side flag such as `HACKATHON_AUTH_BYPASS === 'true'`, ideally limited to non-production environments.
- If the route must exist, make it unavailable in production builds by default.

### 2. Medium: `hackathon-session` accepts arbitrary strings as wallet identities

Files:
- `apps/api/src/routes/auth.ts:77`
- `apps/api/src/routes/auth.ts:138`
- `apps/api/src/routes/auth.ts:142`

Why this matters:
- `HackathonSessionSchema` accepts any string with length `4..128`.
- The value is lowercased and used as the durable user identity key.
- That allows malformed or non-wallet identifiers to create accounts and sessions, which makes collisions and impersonation easier once the bypass route is exposed.

What should change:
- Validate the value as either a strict EVM address or a strict Initia bech32 address.
- Reject invalid identities before user lookup/creation.
- Prefer reusing the same wallet-validation helper used elsewhere in the app instead of keeping this route permissive.

### 3. Medium: switching an agent to paper mode does not clear live-chain linkage

Files:
- `apps/api/src/routes/agents-route/core.ts:119`
- `apps/api/src/routes/agents-route/core.ts:123`
- `apps/api/src/routes/agents-route/core.ts:151`
- `apps/api/src/routes/agents-route/core.ts:152`

Why this matters:
- Agent creation correctly strips `initiaWalletAddress` when `isPaper` is true.
- The update path does not apply the same invariant.
- If an existing live agent is patched with `isPaper: true`, the persisted `initiaWalletAddress` and config payload can remain populated unless the client explicitly clears them, leaving stale live-chain metadata attached to a paper agent.

What should change:
- Enforce the same normalization rules in `PATCH` as in `POST`.
- When the target state is paper mode, clear `initiaWalletAddress` and any other live-only metadata from both the DB columns and serialized config.
- Consider clearing stale sync state at the same time so the UI cannot render outdated on-chain status for a paper agent.

### 4. Low: `dev-session` returns the raw session token in the JSON response body

Files:
- `apps/api/src/routes/auth.ts:264`
- `apps/api/src/routes/auth.ts:294`

Why this matters:
- The endpoint already sets the HttpOnly session cookie.
- Returning `sessionToken` in the JSON body makes the secret easier to leak through logs, test output, or accidental client-side handling.
- This is dev-only, but it is unnecessary exposure.

What should change:
- Remove `sessionToken` from the response payload.
- Keep the cookie as the only transport for the session.

## Notes

I did not find failing tests or build/typecheck breakage in the current tree. The main changes I would make are auth hardening around the hackathon bypass and invariant enforcement when converting agents between live and paper modes.
