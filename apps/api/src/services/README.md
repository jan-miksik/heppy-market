# Services

Entrypoints:
- `llm-router.ts`: compatibility export for the split LLM router under `services/llm-router/*`.
- `coingecko-price.ts`: compatibility export for the split price providers under `services/coingecko-price/*`.
- `dex-data.ts`, `gecko-terminal.ts`, `price-resolver.ts`, `paper-engine.ts`, `snapshot.ts`: feature-facing service surfaces.

State ownership:
- Provider modules own external API access and provider-specific normalization.
- `cache/keys.ts` and `cache/ttl.ts` own shared cache key and TTL constants.

Change here first:
- Change provider-specific logic inside the split submodules before touching compatibility exports.
- Change cache policy in `apps/api/src/cache/ttl.ts` and cache key shape in `apps/api/src/cache/keys.ts`.
- Avoid reintroducing large mixed-responsibility files when a focused submodule already exists.

Related tests:
- `apps/api/tests/coingecko-price.test.ts`
- `apps/api/tests/pairs-normalization.test.ts`
- `apps/api/tests/caching.test.ts`
