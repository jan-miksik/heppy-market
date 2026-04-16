/**
 * Auth routes
 * GET  /api/auth/nonce   — issue a one-time nonce for SIWE
 * POST /api/auth/verify  — verify SIWE message + signature, create session
 * GET  /api/auth/me      — return current user (requires session cookie)
 * POST /api/auth/logout  — delete session
 */
import { Hono } from 'hono';
import { drizzle } from 'drizzle-orm/d1';
import { eq } from 'drizzle-orm';
import type { Env } from '../types/env.js';
import { users } from '../db/schema.js';
import {
  createNonce,
  createSession,
  getSession,
  deleteSession,
  parseCookieValue,
  buildSessionCookie,
  buildExpiredSessionCookie,
  verifySiweAndCreateSession,
} from '../auth/session.js';
import { validateBody } from '../lib/validation.js';
import { z } from 'zod';
import { encryptKey } from '../lib/crypto.js';
import { generateId, nowIso } from '../lib/utils.js';
import { normalizeSupportedWalletAddress } from '../lib/wallet-address.js';
import { forbiddenJson, internalServerErrorJson, notFoundJson, unauthorizedJson, upstreamFailureJson } from './_shared/json-response.js';

const authRoute = new Hono<{ Bindings: Env }>();

function serializeAuthUser(user: typeof users.$inferSelect) {
  return {
    id: user.id,
    walletAddress: user.walletAddress,
    email: user.email,
    displayName: user.displayName,
    authProvider: user.authProvider,
    avatarUrl: user.avatarUrl,
    role: user.role,
    createdAt: user.createdAt,
    openRouterKeySet: !!user.openRouterKey,
  };
}

async function requireAuthenticatedSession(c: {
  req: { header: (name: string) => string | undefined };
  env: Env;
  json: (body: unknown, status?: number) => Response;
}) {
  const cookieHeader = c.req.header('cookie') ?? '';
  const token = parseCookieValue(cookieHeader, 'session');
  if (!token) return { response: c.json({ error: 'Unauthorized' }, 401) };

  const session = await getSession(c.env.CACHE, token, c.env.DB);
  if (!session) return { response: c.json({ error: 'Unauthorized' }, 401) };

  return { token, session };
}

/** GET /api/auth/nonce — generate and return a one-time sign-in nonce */
authRoute.get('/nonce', async (c) => {
  const nonce = await createNonce(c.env.CACHE, c.env.DB);
  return c.json({ nonce });
});

const VerifySchema = z.object({
  message: z.string().min(1),
  signature: z.string().min(1),
  // Optional profile fields from email/social logins
  email: z.string().email().optional(),
  displayName: z.string().max(100).optional(),
  /** Auth provider hint: 'wallet' | 'email' | 'google' | 'github' | 'x' | 'discord' | 'apple' */
  authProvider: z.string().max(50).optional(),
  avatarUrl: z.string().url().optional(),
});

const HackathonSessionSchema = z.object({
  walletAddress: z.string().trim().min(4).max(128),
  displayName: z.string().max(100).optional(),
});

function isHackathonBypassAllowed(env: Pick<Env, 'HACKATHON_AUTH_BYPASS'>): boolean {
  if (env.HACKATHON_AUTH_BYPASS === 'true') return true;
  if (env.HACKATHON_AUTH_BYPASS) {
    console.warn(
      `[auth] HACKATHON_AUTH_BYPASS is set to "${env.HACKATHON_AUTH_BYPASS}" which is not "true" — bypass is NOT active. Use the exact string "true" to enable it.`,
    );
  }
  return false;
}

/** POST /api/auth/verify — verify SIWE, create session, set cookie, return user */
authRoute.post('/verify', async (c) => {
  const body = await validateBody(c, VerifySchema);

  let result;
  try {
    result = await verifySiweAndCreateSession({
      message: body.message,
      signature: body.signature,
      db: c.env.DB,
      cache: c.env.CACHE,
      baseRpcUrl: c.env.BASE_RPC_URL,
      initiaRpcUrl: c.env.INITIA_EVM_RPC,
      email: body.email,
      displayName: body.displayName,
      authProvider: body.authProvider,
      avatarUrl: body.avatarUrl,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Verification failed';
    console.error('[auth/verify] error:', msg, err);
    return unauthorizedJson(c, msg);
  }

  const isHttps = c.req.url.startsWith('https://');
  c.header('Set-Cookie', buildSessionCookie(result.sessionToken, isHttps));

  return c.json(serializeAuthUser(result.user));
});

/** POST /api/auth/hackathon-session — bootstrap a session from connected wallet in localhost/hackathon mode. */
authRoute.post('/hackathon-session', async (c) => {
  if (!isHackathonBypassAllowed(c.env)) {
    return notFoundJson(c);
  }

  // Always log when this bypass endpoint is reached so it is visible in Cloudflare logs.
  const requestHost = new URL(c.req.url).hostname;
  const isLocalhost = /^(localhost|127\.0\.0\.1|0\.0\.0\.0)$/.test(requestHost);
  if (!isLocalhost) {
    console.error('[auth/hackathon-session] HACKATHON_AUTH_BYPASS is active on a non-localhost host:', requestHost);
  } else {
    console.warn('[auth/hackathon-session] Hackathon bypass used — no SIWE verification.');
  }

  const body = await validateBody(c, HackathonSessionSchema);
  const walletAddress = normalizeSupportedWalletAddress(body.walletAddress);
  if (!walletAddress) {
    return c.json({ error: 'Invalid wallet address.' }, 400);
  }
  const orm = drizzle(c.env.DB);

  let [user] = await orm.select().from(users).where(eq(users.walletAddress, walletAddress));
  if (!user) {
    const userId = generateId('user');
    await orm.insert(users).values({
      id: userId,
      walletAddress,
      displayName: body.displayName ?? null,
      authProvider: 'wallet',
      email: null,
      avatarUrl: null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    });
    [user] = await orm.select().from(users).where(eq(users.walletAddress, walletAddress));
  } else if (body.displayName && !user.displayName) {
    await orm.update(users).set({
      displayName: body.displayName,
      updatedAt: nowIso(),
    }).where(eq(users.id, user.id));
    [user] = await orm.select().from(users).where(eq(users.walletAddress, walletAddress));
  }

  const sessionToken = await createSession(c.env.CACHE, user.id, walletAddress, c.env.DB);
  const isHttps = c.req.url.startsWith('https://');
  c.header('Set-Cookie', buildSessionCookie(sessionToken, isHttps));

  return c.json(serializeAuthUser(user));
});

/** GET /api/auth/me — return currently authenticated user */
authRoute.get('/me', async (c) => {
  const auth = await requireAuthenticatedSession(c);
  if ('response' in auth) return auth.response;

  const orm = drizzle(c.env.DB);
  const [user] = await orm.select().from(users).where(eq(users.id, auth.session.userId));
  if (!user) return notFoundJson(c, 'User');

  return c.json(serializeAuthUser(user));
});

/** POST /api/auth/logout — invalidate session */
authRoute.post('/logout', async (c) => {
  const auth = await requireAuthenticatedSession(c);
  if (!('response' in auth)) {
    await deleteSession(c.env.CACHE, auth.token, c.env.DB);
  }

  c.header('Set-Cookie', buildExpiredSessionCookie());
  return c.json({ ok: true });
});

const OpenRouterExchangeSchema = z.object({
  code: z.string().min(1).max(512),
  code_verifier: z.string().min(1).max(512),
  code_challenge_method: z.enum(['S256', 'plain']).optional(),
});

/** POST /api/auth/openrouter/exchange — exchange PKCE code for OR key, encrypt, store */
authRoute.post('/openrouter/exchange', async (c) => {
  const auth = await requireAuthenticatedSession(c);
  if ('response' in auth) return auth.response;

  const body = await validateBody(c, OpenRouterExchangeSchema);

  let res: Response;
  try {
    res = await fetch('https://openrouter.ai/api/v1/auth/keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code: body.code,
        code_verifier: body.code_verifier,
        code_challenge_method: body.code_challenge_method ?? 'S256',
      } satisfies Record<string, string>),
    });
  } catch (fetchErr) {
    console.error('[auth/openrouter/exchange] Network error reaching OpenRouter:', fetchErr);
    return upstreamFailureJson(c, 'Could not reach OpenRouter — network error');
  }

  if (!res.ok) {
    const text = await res.text();
    console.error('[auth/openrouter/exchange] OpenRouter error:', res.status, text);
    // Parse JSON error if available, otherwise return raw text
    let detail = text;
    try { detail = JSON.parse(text)?.error ?? text; } catch { /* raw text is fine */ }
    return upstreamFailureJson(c, `OpenRouter exchange failed (${res.status}): ${detail}`);
  }

  const data = await res.json<{ key?: string }>();
  if (!data.key) return upstreamFailureJson(c, 'No key in OpenRouter response');

  const encrypted = await encryptKey(data.key, c.env.KEY_ENCRYPTION_SECRET);
  const orm = drizzle(c.env.DB);
  await orm
    .update(users)
    .set({ openRouterKey: encrypted, updatedAt: nowIso() })
    .where(eq(users.id, auth.session.userId));

  return c.json({ ok: true });
});

/** DELETE /api/auth/openrouter/disconnect — remove stored OR key */
authRoute.delete('/openrouter/disconnect', async (c) => {
  const auth = await requireAuthenticatedSession(c);
  if ('response' in auth) return auth.response;

  const orm = drizzle(c.env.DB);
  await orm
    .update(users)
    .set({ openRouterKey: null, updatedAt: nowIso() })
    .where(eq(users.id, auth.session.userId));

  return c.json({ ok: true });
});

/**
 * POST /api/auth/dev-session — create a session without SIWE (Playwright / local dev only).
 * Requires X-Playwright-Secret header matching the PLAYWRIGHT_SECRET env var.
 * This endpoint is a no-op (404) when PLAYWRIGHT_SECRET is not configured.
 */
authRoute.post('/dev-session', async (c) => {
  console.warn('[auth] /dev-session endpoint invoked — this endpoint is for Playwright/local dev only and must not be reachable in production.');
  const secret = c.env.PLAYWRIGHT_SECRET;
  if (!secret) return notFoundJson(c);

  const provided = c.req.header('x-playwright-secret');
  if (!provided || provided !== secret) return forbiddenJson(c);

  const PLAYWRIGHT_WALLET = '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
  const orm = drizzle(c.env.DB);

  let [user] = await orm.select().from(users).where(eq(users.walletAddress, PLAYWRIGHT_WALLET));
  if (!user) {
    const userId = generateId('user');
    await orm.insert(users).values({
      id: userId,
      walletAddress: PLAYWRIGHT_WALLET,
      displayName: 'Playwright Test User',
      authProvider: 'playwright',
      email: null,
      avatarUrl: null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    });
    [user] = await orm.select().from(users).where(eq(users.walletAddress, PLAYWRIGHT_WALLET));
  }

  const sessionToken = await createSession(c.env.CACHE, user.id, PLAYWRIGHT_WALLET, c.env.DB);
  const isHttps = c.req.url.startsWith('https://');
  c.header('Set-Cookie', buildSessionCookie(sessionToken, isHttps));

  return c.json({ ok: true, userId: user.id, walletAddress: PLAYWRIGHT_WALLET });
});

authRoute.onError((err, c) => {
  console.error('[auth route]', err);
  return internalServerErrorJson(c);
});

export default authRoute;
