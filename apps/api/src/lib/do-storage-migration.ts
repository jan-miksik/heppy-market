/**
 * DO storage schema versioning and migration runner.
 *
 * Design:
 * - Each DO stores `storageVersion: number` as a sentinel.
 * - On every `fetch()` (or at DO startup), call `migrateStorage(storage)`.
 *   It runs any pending migrations in version order, then stamps the new version.
 * - Migrations are pure transforms: they read existing keys and write new ones.
 *   They MUST be idempotent (safe to re-run if interrupted).
 *
 * Adding a migration:
 *   1. Write a function `v<N>_<description>(storage)` below.
 *   2. Add it to the `MIGRATIONS` array in order.
 *   3. Bump `CURRENT_STORAGE_VERSION` to N.
 *
 * Never remove or reorder migrations — they are append-only.
 */
/** Current schema version. Bump when adding a new migration. */
export const CURRENT_STORAGE_VERSION = 1;

/** A single schema migration: receives the DO storage and upgrades it. */
type Migration = (storage: StorageLike) => Promise<void>;

// ── Migrations (append-only) ──────────────────────────────────────────────────

/**
 * v1: Initial versioning.
 * Establishes the `storageVersion` key. Existing DOs (no version key)
 * are treated as v0 and upgraded to v1 — no data changes needed, just stamping.
 */
async function v1_initial_versioning(_storage: StorageLike): Promise<void> {
  // No structural changes needed for v1.
  // Future migrations would transform storage keys here.
}

/**
 * All migrations in order. Index 0 = migration from v0 → v1, etc.
 * NEVER reorder or remove entries.
 */
const MIGRATIONS: Migration[] = [
  v1_initial_versioning, // v0 → v1
];

// ── Migration runner ──────────────────────────────────────────────────────────

/**
 * Run any pending migrations for this DO storage instance.
 * Safe to call on every fetch — exits immediately if already up-to-date.
 *
 * @param storage - The DO's `ctx.storage` instance.
 */
// Use a structural type so this module works regardless of CF Workers type resolution.
type StorageLike = {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
};

export async function migrateStorage(storage: StorageLike): Promise<void> {
  const currentVersion = ((await storage.get('storageVersion')) as number | undefined) ?? 0;

  if (currentVersion >= CURRENT_STORAGE_VERSION) {
    return; // already up-to-date — fast path
  }

  for (let v = currentVersion; v < CURRENT_STORAGE_VERSION; v++) {
    const migration = MIGRATIONS[v];
    if (migration) {
      console.log(`[do-migration] Applying migration v${v} → v${v + 1}`);
      await migration(storage);
    }
    // Stamp the new version after each successful migration so interrupted
    // runs can resume from the correct checkpoint.
    await storage.put('storageVersion', v + 1);
  }

  console.log(`[do-migration] Storage at version ${CURRENT_STORAGE_VERSION}`);
}
