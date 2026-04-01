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
  verifySiweAndCreateSession,
  createNonce,
  createSession,
  getSession,
  deleteSession,
  parseCookieValue,
  buildSessionCookie,
  buildExpiredSessionCookie,
} from '../lib/auth.js';
import { validateBody } from '../lib/validation.js';
import { z } from 'zod';
import { encryptKey } from '../lib/crypto.js';
import { generateId, nowIso } from '../lib/utils.js';

const authRoute = new Hono<{ Bindings: Env }>();

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
    return c.json({ error: msg }, 401);
  }

  const isHttps = c.req.url.startsWith('https://');
  c.header('Set-Cookie', buildSessionCookie(result.sessionToken, isHttps));

  return c.json({
    id: result.user.id,
    walletAddress: result.user.walletAddress,
    email: result.user.email,
    displayName: result.user.displayName,
    authProvider: result.user.authProvider,
    avatarUrl: result.user.avatarUrl,
    role: result.user.role,
    createdAt: result.user.createdAt,
    openRouterKeySet: !!result.user.openRouterKey,
  });
});

/** GET /api/auth/me — return currently authenticated user */
authRoute.get('/me', async (c) => {
  const cookieHeader = c.req.header('cookie') ?? '';
  const token = parseCookieValue(cookieHeader, 'session');
  if (!token) return c.json({ error: 'Unauthorized' }, 401);

  const session = await getSession(c.env.CACHE, token, c.env.DB);
  if (!session) return c.json({ error: 'Unauthorized' }, 401);

  const orm = drizzle(c.env.DB);
  const [user] = await orm.select().from(users).where(eq(users.id, session.userId));
  if (!user) return c.json({ error: 'User not found' }, 404);

  return c.json({
    id: user.id,
    walletAddress: user.walletAddress,
    email: user.email,
    displayName: user.displayName,
    authProvider: user.authProvider,
    avatarUrl: user.avatarUrl,
    role: user.role,
    createdAt: user.createdAt,
    openRouterKeySet: !!user.openRouterKey,
  });
});

/** POST /api/auth/logout — invalidate session */
authRoute.post('/logout', async (c) => {
  const cookieHeader = c.req.header('cookie') ?? '';
  const token = parseCookieValue(cookieHeader, 'session');
  if (token) await deleteSession(c.env.CACHE, token, c.env.DB);

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
  const cookieHeader = c.req.header('cookie') ?? '';
  const token = parseCookieValue(cookieHeader, 'session');
  if (!token) return c.json({ error: 'Unauthorized' }, 401);

  const session = await getSession(c.env.CACHE, token, c.env.DB);
  if (!session) return c.json({ error: 'Unauthorized' }, 401);

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
    return c.json({ error: 'Could not reach OpenRouter — network error' }, 502);
  }

  if (!res.ok) {
    const text = await res.text();
    console.error('[auth/openrouter/exchange] OpenRouter error:', res.status, text);
    // Parse JSON error if available, otherwise return raw text
    let detail = text;
    try { detail = JSON.parse(text)?.error ?? text; } catch { /* raw text is fine */ }
    return c.json({ error: `OpenRouter exchange failed (${res.status}): ${detail}` }, 502);
  }

  const data = await res.json<{ key?: string }>();
  if (!data.key) return c.json({ error: 'No key in OpenRouter response' }, 502);

  const encrypted = await encryptKey(data.key, c.env.KEY_ENCRYPTION_SECRET);
  const orm = drizzle(c.env.DB);
  await orm
    .update(users)
    .set({ openRouterKey: encrypted, updatedAt: nowIso() })
    .where(eq(users.id, session.userId));

  return c.json({ ok: true });
});

/** DELETE /api/auth/openrouter/disconnect — remove stored OR key */
authRoute.delete('/openrouter/disconnect', async (c) => {
  const cookieHeader = c.req.header('cookie') ?? '';
  const token = parseCookieValue(cookieHeader, 'session');
  if (!token) return c.json({ error: 'Unauthorized' }, 401);

  const session = await getSession(c.env.CACHE, token, c.env.DB);
  if (!session) return c.json({ error: 'Unauthorized' }, 401);

  const orm = drizzle(c.env.DB);
  await orm
    .update(users)
    .set({ openRouterKey: null, updatedAt: nowIso() })
    .where(eq(users.id, session.userId));

  return c.json({ ok: true });
});

/**
 * POST /api/auth/dev-session — create a session without SIWE (Playwright / local dev only).
 * Requires X-Playwright-Secret header matching the PLAYWRIGHT_SECRET env var.
 * This endpoint is a no-op (404) when PLAYWRIGHT_SECRET is not configured.
 */
authRoute.post('/dev-session', async (c) => {
  const secret = c.env.PLAYWRIGHT_SECRET;
  if (!secret) return c.json({ error: 'Not Found' }, 404);

  const provided = c.req.header('x-playwright-secret');
  if (!provided || provided !== secret) return c.json({ error: 'Forbidden' }, 403);

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

  return c.json({ ok: true, userId: user.id, walletAddress: PLAYWRIGHT_WALLET, sessionToken });
});

authRoute.onError((err, c) => {
  console.error('[auth route]', err);
  return c.json({ error: 'Internal server error' }, 500);
});

export default authRoute;
