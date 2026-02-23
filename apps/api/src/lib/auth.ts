/**
 * Auth library — session management + SIWE verification + Hono middleware.
 * Sessions are stored in KV with a 7-day TTL (no JWT needed).
 */
import { verifyMessage } from 'viem';
import { drizzle } from 'drizzle-orm/d1';
import { eq } from 'drizzle-orm';
import { users } from '../db/schema.js';
import { generateId, nowIso } from './utils.js';

const SESSION_TTL_SECS = 60 * 60 * 24 * 7; // 7 days

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
  walletAddress: string
): Promise<string> {
  const token = generateId(); // 32-byte hex = 256-bit entropy
  const session: SessionData = {
    userId,
    walletAddress,
    expiresAt: Date.now() + SESSION_TTL_SECS * 1000,
  };
  await cache.put(`session:${token}`, JSON.stringify(session), {
    expirationTtl: SESSION_TTL_SECS,
  });
  return token;
}

/** Look up a session by token. Returns null if missing or expired. */
export async function getSession(
  cache: KVNamespace,
  token: string
): Promise<SessionData | null> {
  const raw = await cache.get(`session:${token}`, 'text');
  if (!raw) return null;
  try {
    const session = JSON.parse(raw) as SessionData;
    if (session.expiresAt < Date.now()) {
      await cache.delete(`session:${token}`);
      return null;
    }
    return session;
  } catch {
    return null;
  }
}

/** Delete a session (logout) */
export async function deleteSession(cache: KVNamespace, token: string): Promise<void> {
  await cache.delete(`session:${token}`);
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

export interface VerifySiweOptions {
  message: string;
  signature: string;
  db: D1Database;
  cache: KVNamespace;
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

  // Validate nonce exists (one-time use)
  const nonceRaw = await cache.get(`nonce:${parsed.nonce}`, 'text');
  if (!nonceRaw) throw new Error('Invalid or expired nonce');

  // Verify EIP-191 signature using viem (works in CF Workers via WebCrypto)
  let isValid = false;
  try {
    isValid = await verifyMessage({
      address: parsed.address as `0x${string}`,
      message,
      signature: signature as `0x${string}`,
    });
  } catch {
    throw new Error('Signature verification failed');
  }
  if (!isValid) throw new Error('Invalid signature');

  // Consume nonce to prevent replay
  await cache.delete(`nonce:${parsed.nonce}`);

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
  const sessionToken = await createSession(cache, userId, walletAddress);
  return { user, sessionToken };
}

// ─── Hono auth middleware ──────────────────────────────────────────────────────

type AnyContext = {
  req: { header: (k: string) => string | undefined };
  env: { CACHE: KVNamespace };
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

    const session = await getSession(c.env.CACHE, token);
    if (!session) return c.json({ error: 'Unauthorized' }, 401);

    c.set('userId', session.userId);
    c.set('walletAddress', session.walletAddress);
    await next();
  };
}
