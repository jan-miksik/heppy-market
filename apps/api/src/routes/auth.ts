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
  getSession,
  deleteSession,
  parseCookieValue,
  buildSessionCookie,
  buildExpiredSessionCookie,
} from '../lib/auth.js';
import { validateBody } from '../lib/validation.js';
import { z } from 'zod';

const authRoute = new Hono<{ Bindings: Env }>();

const NONCE_TTL_SECS = 300; // 5 minutes

/** GET /api/auth/nonce — generate and return a one-time sign-in nonce */
authRoute.get('/nonce', async (c) => {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const nonce = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  await c.env.CACHE.put(`nonce:${nonce}`, '1', { expirationTtl: NONCE_TTL_SECS });
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
    createdAt: result.user.createdAt,
  });
});

/** GET /api/auth/me — return currently authenticated user */
authRoute.get('/me', async (c) => {
  const cookieHeader = c.req.header('cookie') ?? '';
  const token = parseCookieValue(cookieHeader, 'session');
  if (!token) return c.json({ error: 'Unauthorized' }, 401);

  const session = await getSession(c.env.CACHE, token);
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
    createdAt: user.createdAt,
  });
});

/** POST /api/auth/logout — invalidate session */
authRoute.post('/logout', async (c) => {
  const cookieHeader = c.req.header('cookie') ?? '';
  const token = parseCookieValue(cookieHeader, 'session');
  if (token) await deleteSession(c.env.CACHE, token);

  c.header('Set-Cookie', buildExpiredSessionCookie());
  return c.json({ ok: true });
});

authRoute.onError((err, c) => {
  console.error('[auth route]', err);
  return c.json({ error: 'Internal server error' }, 500);
});

export default authRoute;
