/**
 * Auth library — session management + SIWE verification + Hono middleware.
 * Sessions are stored in KV with a 7-day TTL (no JWT needed).
 */
import { createPublicClient, http } from 'viem';
import { base, baseSepolia } from 'viem/chains';
import { drizzle } from 'drizzle-orm/d1';
import { eq } from 'drizzle-orm';
import { users } from '../db/schema.js';
import { generateId, nowIso } from './utils.js';

const SESSION_TTL_SECS = 60 * 60 * 24 * 7; // 7 days
const SESSION_HOT_CACHE_TTL_MS = 30_000; // short per-isolate cache to reduce KV reads
const SESSION_HOT_CACHE_MAX_ENTRIES = 5_000;
const NONCE_TTL_SECS = 300; // 5 minutes

type SessionHotCacheEntry = {
  session: SessionData;
  cachedUntil: number;
};

const sessionHotCache = new Map<string, SessionHotCacheEntry>();
let sessionHotCacheLastCleanupMs = 0;
let authTablesReady = false;
let authTablesInitPromise: Promise<void> | null = null;

function cleanupSessionHotCache(nowMs: number): void {
  if (nowMs - sessionHotCacheLastCleanupMs < 10_000) return;
  sessionHotCacheLastCleanupMs = nowMs;

  for (const [key, entry] of sessionHotCache) {
    if (entry.cachedUntil <= nowMs || entry.session.expiresAt <= nowMs) {
      sessionHotCache.delete(key);
    }
  }

  if (sessionHotCache.size > SESSION_HOT_CACHE_MAX_ENTRIES) {
    let toDelete = sessionHotCache.size - SESSION_HOT_CACHE_MAX_ENTRIES;
    for (const key of sessionHotCache.keys()) {
      sessionHotCache.delete(key);
      toDelete--;
      if (toDelete <= 0) break;
    }
  }
}

async function ensureAuthTables(db: D1Database): Promise<void> {
  if (authTablesReady) return;
  if (!authTablesInitPromise) {
    authTablesInitPromise = (async () => {
      await db
        .prepare(
          `CREATE TABLE IF NOT EXISTS auth_sessions (
            token TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            wallet_address TEXT NOT NULL,
            expires_at INTEGER NOT NULL,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
          )`
        )
        .run();
      await db
        .prepare(
          `CREATE INDEX IF NOT EXISTS idx_auth_sessions_expires_at
           ON auth_sessions (expires_at)`
        )
        .run();

      await db
        .prepare(
          `CREATE TABLE IF NOT EXISTS auth_nonces (
            nonce TEXT PRIMARY KEY,
            expires_at INTEGER NOT NULL,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
          )`
        )
        .run();
      await db
        .prepare(
          `CREATE INDEX IF NOT EXISTS idx_auth_nonces_expires_at
           ON auth_nonces (expires_at)`
        )
        .run();
      authTablesReady = true;
    })().catch((err) => {
      authTablesInitPromise = null;
      throw err;
    });
  }
  await authTablesInitPromise;
}

async function persistSessionDb(
  db: D1Database,
  token: string,
  session: SessionData
): Promise<void> {
  await ensureAuthTables(db);
  await db
    .prepare(
      `INSERT OR REPLACE INTO auth_sessions (token, user_id, wallet_address, expires_at)
       VALUES (?, ?, ?, ?)`
    )
    .bind(token, session.userId, session.walletAddress, session.expiresAt)
    .run();
}

async function readSessionDb(
  db: D1Database,
  token: string
): Promise<SessionData | null> {
  await ensureAuthTables(db);
  const row = await db
    .prepare(
      `SELECT user_id AS userId, wallet_address AS walletAddress, expires_at AS expiresAt
       FROM auth_sessions
       WHERE token = ?`
    )
    .bind(token)
    .first<SessionData>();
  return row ?? null;
}

async function deleteSessionDb(db: D1Database, token: string): Promise<void> {
  await ensureAuthTables(db);
  await db.prepare(`DELETE FROM auth_sessions WHERE token = ?`).bind(token).run();
}

async function persistNonceDb(
  db: D1Database,
  nonce: string,
  expiresAt: number
): Promise<void> {
  await ensureAuthTables(db);
  await db
    .prepare(
      `INSERT OR REPLACE INTO auth_nonces (nonce, expires_at)
       VALUES (?, ?)`
    )
    .bind(nonce, expiresAt)
    .run();
}

async function consumeNonceDb(
  db: D1Database,
  nonce: string
): Promise<boolean> {
  await ensureAuthTables(db);
  const now = Date.now();
  const result = await db
    .prepare(
      `DELETE FROM auth_nonces
       WHERE nonce = ? AND expires_at >= ?`
    )
    .bind(nonce, now)
    .run();
  const changes = Number(result.meta.changes ?? 0);
  return changes > 0;
}

export async function createNonce(
  cache: KVNamespace,
  db: D1Database
): Promise<string> {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const nonce = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  const expiresAt = Date.now() + NONCE_TTL_SECS * 1000;
  await persistNonceDb(db, nonce, expiresAt);

  try {
    await cache.put(`nonce:${nonce}`, '1', { expirationTtl: NONCE_TTL_SECS });
  } catch {
    // KV is optional acceleration only.
  }

  return nonce;
}

export async function consumeNonce(
  cache: KVNamespace,
  db: D1Database,
  nonce: string
): Promise<boolean> {
  const consumed = await consumeNonceDb(db, nonce);

  try {
    await cache.delete(`nonce:${nonce}`);
  } catch {
    // KV is optional acceleration only.
  }

  return consumed;
}

export interface SessionData {
  userId: string;
  walletAddress: string;
  expiresAt: number; // Unix ms
}

/** Variables attached to Hono context by auth middleware */
export interface AuthVariables {
  userId: string;
  walletAddress: string;
}

// ─── Session helpers ───────────────────────────────────────────────────────────

/** Generate a session token and store it in KV */
export async function createSession(
  cache: KVNamespace,
  userId: string,
  walletAddress: string,
  db?: D1Database
): Promise<string> {
  const token = generateId(); // 32-byte hex = 256-bit entropy
  const session: SessionData = {
    userId,
    walletAddress,
    expiresAt: Date.now() + SESSION_TTL_SECS * 1000,
  };
  const key = `session:${token}`;
  let persisted = false;

  if (db) {
    try {
      await persistSessionDb(db, token, session);
      persisted = true;
    } catch (err) {
      console.error('[auth] failed to persist session in D1:', err);
    }
  }

  try {
    await cache.put(key, JSON.stringify(session), {
      expirationTtl: SESSION_TTL_SECS,
    });
    persisted = true;
  } catch {
    // KV is optional acceleration only.
  }

  if (!persisted) {
    throw new Error('Unable to persist session');
  }

  sessionHotCache.set(key, {
    session,
    cachedUntil: Math.min(session.expiresAt, Date.now() + SESSION_HOT_CACHE_TTL_MS),
  });
  return token;
}

/** Look up a session by token. Returns null if missing or expired. */
export async function getSession(
  cache: KVNamespace,
  token: string,
  db?: D1Database
): Promise<SessionData | null> {
  // Reject obviously invalid tokens before hitting KV (prevents probing with empty/crafted strings)
  if (!token || token.length < 16 || token.length > 128 || !/^[0-9a-f]+$/.test(token)) return null;

  const now = Date.now();
  cleanupSessionHotCache(now);

  const key = `session:${token}`;
  const hot = sessionHotCache.get(key);
  if (hot && hot.cachedUntil > now && hot.session.expiresAt > now) {
    return hot.session;
  }
  if (hot) sessionHotCache.delete(key);

  try {
    const raw = await cache.get(key, 'text');
    if (raw) {
      const session = JSON.parse(raw) as SessionData;
      if (session.expiresAt < now) {
        await cache.delete(key).catch(() => {});
        if (db) await deleteSessionDb(db, token).catch(() => {});
        sessionHotCache.delete(key);
        return null;
      }
      sessionHotCache.set(key, {
        session,
        cachedUntil: Math.min(session.expiresAt, now + SESSION_HOT_CACHE_TTL_MS),
      });
      return session;
    }
  } catch {
    // KV unavailable; try durable fallback.
  }

  if (!db) return null;

  try {
    const session = await readSessionDb(db, token);
    if (!session) return null;
    if (session.expiresAt < now) {
      await deleteSessionDb(db, token).catch(() => {});
      await cache.delete(key).catch(() => {});
      sessionHotCache.delete(key);
      return null;
    }
    sessionHotCache.set(key, {
      session,
      cachedUntil: Math.min(session.expiresAt, now + SESSION_HOT_CACHE_TTL_MS),
    });
    return session;
  } catch {
    return null;
  }
}

/** Delete a session (logout) */
export async function deleteSession(
  cache: KVNamespace,
  token: string,
  db?: D1Database
): Promise<void> {
  const key = `session:${token}`;
  sessionHotCache.delete(key);
  await Promise.all([
    cache.delete(key).catch(() => {}),
    db ? deleteSessionDb(db, token).catch(() => {}) : Promise.resolve(),
  ]);
}

/** Build a Set-Cookie header value for the session token */
export function buildSessionCookie(token: string, isHttps: boolean): string {
  const parts = [
    `session=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${SESSION_TTL_SECS}`,
  ];
  if (isHttps) parts.push('Secure');
  return parts.join('; ');
}

/** Build a Set-Cookie that expires the session (logout) */
export function buildExpiredSessionCookie(): string {
  return 'session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0';
}

// ─── Cookie parsing ────────────────────────────────────────────────────────────

/** Extract a named cookie value from a Cookie header string */
export function parseCookieValue(cookieHeader: string, name: string): string | null {
  for (const part of cookieHeader.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k?.trim() === name) return rest.join('=').trim();
  }
  return null;
}

// ─── SIWE verification ─────────────────────────────────────────────────────────

interface ParsedSiwe {
  address: string;
  nonce: string;
  domain: string;
  chainId: number;
}

/** Extract address, nonce, domain and chainId from a SIWE message string */
export function parseSiweMessage(message: string): ParsedSiwe {
  const lines = message.split('\n');
  const address = lines[1]?.trim() ?? '';
  const nonce = (lines.find((l) => l.startsWith('Nonce:')) ?? '').replace('Nonce:', '').trim();
  const chainId = parseInt(
    (lines.find((l) => l.startsWith('Chain ID:')) ?? '').replace('Chain ID:', '').trim() || '0',
    10
  );
  const domain = (lines[0] ?? '').split(' wants you to')[0].trim();
  return { address, nonce, domain, chainId };
}

/** Allowed SIWE domains — prevents accepting messages signed for a different site */
const ALLOWED_SIWE_DOMAINS = [
  'localhost',
  'localhost:3000',
  'localhost:3001',
  'localhost:3002',
  'heppy.market',
  'heppy-market.pages.dev',
  'dex-trading-agents.pages.dev',
];

export interface VerifySiweOptions {
  message: string;
  signature: string;
  db: D1Database;
  cache: KVNamespace;
  /** RPC URL for on-chain ERC-1271/ERC-6492 (smart account) signature verification */
  rpcUrl?: string;
  /** Optional profile fields from email/social logins */
  email?: string;
  displayName?: string;
  authProvider?: string;
  avatarUrl?: string;
}

export interface VerifySiweResult {
  user: typeof users.$inferSelect;
  sessionToken: string;
}

/**
 * Verify a SIWE message + signature, upsert the user in D1,
 * and create a session in KV. Returns the user and session token.
 */
export async function verifySiweAndCreateSession(
  opts: VerifySiweOptions
): Promise<VerifySiweResult> {
  const { message, signature, db: d1, cache } = opts;

  const parsed = parseSiweMessage(message);
  if (!parsed.address || !parsed.nonce) {
    throw new Error('Invalid SIWE message format');
  }

  // Validate domain to prevent phishing (signing on another site, replaying here)
  const domainAllowed = ALLOWED_SIWE_DOMAINS.some(
    (allowed) => parsed.domain === allowed || parsed.domain.endsWith(`.${allowed}`)
  );
  if (!domainAllowed) {
    throw new Error(`SIWE domain "${parsed.domain}" is not allowed`);
  }

  // Validate and consume nonce (one-time use), backed by D1 (KV optional).
  const nonceValid = await consumeNonce(cache, d1, parsed.nonce);
  if (!nonceValid) throw new Error('Invalid or expired nonce');

  // Use publicClient.verifyMessage() which handles EOA (ECDSA), deployed smart
  // accounts (ERC-1271), and counterfactual smart accounts (ERC-6492).
  // Standalone verifyMessage() only does ECDSA and will throw on Safe/AA wallets.
  const chain = parsed.chainId === 84532 ? baseSepolia : base;
  const rpcUrl = opts.rpcUrl ?? (parsed.chainId === 84532
    ? 'https://sepolia.base.org'
    : 'https://mainnet.base.org');

  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });

  let isValid = false;
  try {
    isValid = await publicClient.verifyMessage({
      address: parsed.address as `0x${string}`,
      message,
      signature: signature as `0x${string}`,
    });
  } catch (err) {
    console.error('[auth] verifyMessage error:', (err as Error)?.message);
    throw new Error('Signature verification failed');
  }
  if (!isValid) throw new Error('Invalid signature');

  // Normalise address to lowercase
  const walletAddress = parsed.address.toLowerCase();

  // Upsert user
  const orm = drizzle(d1);
  const [existing] = await orm.select().from(users).where(eq(users.walletAddress, walletAddress));

  let userId: string;
  if (existing) {
    userId = existing.id;
    // Update profile fields only if not already set
    const updates: Partial<typeof users.$inferInsert> = { updatedAt: nowIso() };
    if (opts.email && !existing.email) updates.email = opts.email;
    if (opts.displayName && !existing.displayName) updates.displayName = opts.displayName;
    if (opts.avatarUrl && !existing.avatarUrl) updates.avatarUrl = opts.avatarUrl;
    if (opts.authProvider) updates.authProvider = opts.authProvider;
    await orm.update(users).set(updates).where(eq(users.id, userId));
  } else {
    userId = generateId('user');
    await orm.insert(users).values({
      id: userId,
      walletAddress,
      email: opts.email ?? null,
      displayName: opts.displayName ?? null,
      authProvider: opts.authProvider ?? 'wallet',
      avatarUrl: opts.avatarUrl ?? null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    });
  }

  const [user] = await orm.select().from(users).where(eq(users.id, userId));
  const sessionToken = await createSession(cache, userId, walletAddress, d1);
  return { user, sessionToken };
}

// ─── Hono auth middleware ──────────────────────────────────────────────────────

type AnyContext = {
  req: { header: (k: string) => string | undefined };
  env: { CACHE: KVNamespace; DB: D1Database };
  set: (k: string, v: unknown) => void;
  json: (body: unknown, status?: number) => Response;
};

/**
 * Hono middleware — reads the `session` cookie, validates it in KV,
 * and attaches `userId` + `walletAddress` to the context.
 * Returns 401 if missing or invalid.
 */
export function createAuthMiddleware() {
  return async (c: AnyContext, next: () => Promise<void>): Promise<Response | void> => {
    const cookieHeader = c.req.header('cookie') ?? '';
    const token = parseCookieValue(cookieHeader, 'session');
    if (!token) return c.json({ error: 'Unauthorized' }, 401);

    const session = await getSession(c.env.CACHE, token, c.env.DB);
    if (!session) return c.json({ error: 'Unauthorized' }, 401);

    c.set('userId', session.userId);
    c.set('walletAddress', session.walletAddress);
    await next();
  };
}
