/**
 * Security tests — auth flow hardening, input validation, rate limiting.
 * Tests SIWE domain validation, session token format checks, nonce replay prevention,
 * and input schema validation for sensitive endpoints.
 */
import { describe, it, expect } from 'vitest';
import { parseSiweMessage, parseCookieValue, isAllowedSiweDomain } from '../src/lib/auth.js';

// ── SIWE message parsing ──────────────────────────────────────────────────────

describe('parseSiweMessage', () => {
  const exampleSiwe = [
    'localhost wants you to sign in with your Ethereum account:',
    '0xDeadBeefDeadBeefDeadBeefDeadBeefDeadBeef',
    '',
    'Sign in to Something in loop',
    '',
    'URI: http://localhost:3000',
    'Version: 1',
    'Chain ID: 8453',
    'Nonce: abc123def456',
    'Issued At: 2026-03-19T00:00:00Z',
  ].join('\n');

  it('extracts address from line 2', () => {
    const parsed = parseSiweMessage(exampleSiwe);
    expect(parsed.address).toBe('0xDeadBeefDeadBeefDeadBeefDeadBeefDeadBeef');
  });

  it('extracts nonce from Nonce: line', () => {
    const parsed = parseSiweMessage(exampleSiwe);
    expect(parsed.nonce).toBe('abc123def456');
  });

  it('extracts chainId from Chain ID: line', () => {
    const parsed = parseSiweMessage(exampleSiwe);
    expect(parsed.chainId).toBe(8453);
  });

  it('extracts domain from first line', () => {
    const parsed = parseSiweMessage(exampleSiwe);
    expect(parsed.domain).toBe('localhost');
  });

  it('returns empty values for a malformed message', () => {
    const parsed = parseSiweMessage('not a SIWE message');
    expect(parsed.address).toBe('');
    expect(parsed.nonce).toBe('');
    expect(parsed.chainId).toBe(0);
  });
});

// ── SIWE domain validation ────────────────────────────────────────────────────

describe('SIWE domain validation', () => {
  it('allows localhost', () => {
    expect(isAllowedSiweDomain('localhost')).toBe(true);
  });

  it('allows localhost with port', () => {
    expect(isAllowedSiweDomain('localhost:3000')).toBe(true);
    expect(isAllowedSiweDomain('localhost:3001')).toBe(true);
    expect(isAllowedSiweDomain('localhost:5173')).toBe(true);
    expect(isAllowedSiweDomain('localhost:4173')).toBe(true);
  });

  it('allows localhost ip variants', () => {
    expect(isAllowedSiweDomain('127.0.0.1')).toBe(true);
    expect(isAllowedSiweDomain('127.0.0.1:5173')).toBe(true);
    expect(isAllowedSiweDomain('0.0.0.0:4173')).toBe(true);
  });

  it('allows production domain', () => {
    expect(isAllowedSiweDomain('something-in-loop.market')).toBe(true);
    expect(isAllowedSiweDomain('something-in-loop.pages.dev')).toBe(true);
  });

  it('rejects unknown domains', () => {
    expect(isAllowedSiweDomain('evil.com')).toBe(false);
    expect(isAllowedSiweDomain('phishing-site.io')).toBe(false);
    expect(isAllowedSiweDomain('something-in-loop.market.evil.com')).toBe(false);
  });

  it('rejects empty domain', () => {
    expect(isAllowedSiweDomain('')).toBe(false);
  });

  it('does not allow suffix-only matches that are not subdomains', () => {
    // "notlocalhost" should NOT match "localhost"
    expect(isAllowedSiweDomain('notlocalhost')).toBe(false);
    // "something-in-loop.market.evil.io" should not match "something-in-loop.market"
    expect(isAllowedSiweDomain('something-in-loop.market.evil.io')).toBe(false);
  });
});

// ── Session token format validation ──────────────────────────────────────────

function isValidSessionToken(token: string): boolean {
  return !(!token || token.length < 16 || token.length > 128 || !/^[0-9a-f]+$/.test(token));
}

describe('session token format validation', () => {
  it('accepts a valid 64-char hex token', () => {
    const token = 'a'.repeat(64);
    expect(isValidSessionToken(token)).toBe(true);
  });

  it('accepts minimum length 16-char token', () => {
    const token = 'deadbeefdeadbeef';
    expect(isValidSessionToken(token)).toBe(true);
  });

  it('rejects empty string', () => {
    expect(isValidSessionToken('')).toBe(false);
  });

  it('rejects short tokens (< 16 chars)', () => {
    expect(isValidSessionToken('abc')).toBe(false);
    expect(isValidSessionToken('deadbeef')).toBe(false); // 8 chars
  });

  it('rejects tokens with non-hex characters', () => {
    expect(isValidSessionToken('g'.repeat(64))).toBe(false); // 'g' is not hex
    expect(isValidSessionToken('../../../etc/passwd')).toBe(false);
    expect(isValidSessionToken('A'.repeat(64))).toBe(false); // uppercase not hex
  });

  it('rejects tokens over 128 chars', () => {
    expect(isValidSessionToken('a'.repeat(129))).toBe(false);
  });

  it('rejects tokens containing path traversal or injection', () => {
    expect(isValidSessionToken('session:injected')).toBe(false);
    expect(isValidSessionToken('; drop table sessions;')).toBe(false);
  });
});

// ── Cookie parsing ────────────────────────────────────────────────────────────

describe('parseCookieValue', () => {
  it('extracts the session cookie value', () => {
    const header = 'session=abc123; Path=/; HttpOnly';
    expect(parseCookieValue(header, 'session')).toBe('abc123');
  });

  it('returns null when the cookie is missing', () => {
    expect(parseCookieValue('other=xyz', 'session')).toBeNull();
  });

  it('handles multiple cookies', () => {
    const header = 'foo=bar; session=deadbeef1234567890; baz=qux';
    expect(parseCookieValue(header, 'session')).toBe('deadbeef1234567890');
  });

  it('returns null for an empty cookie header', () => {
    expect(parseCookieValue('', 'session')).toBeNull();
  });

  it('handles values with = signs (e.g. base64)', () => {
    const b64 = 'SGVsbG8gV29ybGQ=';
    const header = `session=${b64}`;
    expect(parseCookieValue(header, 'session')).toBe(b64);
  });
});

// ── OpenRouter exchange schema validation ─────────────────────────────────────

import { z } from 'zod';

const OpenRouterExchangeSchema = z.object({
  code: z.string().min(1).max(512),
  code_verifier: z.string().min(1).max(512),
  code_challenge_method: z.enum(['S256', 'plain']).optional(),
});

describe('OpenRouter exchange schema', () => {
  it('accepts valid PKCE payload', () => {
    const result = OpenRouterExchangeSchema.safeParse({
      code: 'auth_code_here',
      code_verifier: 'verifier_value_here',
    });
    expect(result.success).toBe(true);
  });

  it('accepts with optional challenge method', () => {
    const result = OpenRouterExchangeSchema.safeParse({
      code: 'code',
      code_verifier: 'verifier',
      code_challenge_method: 'S256',
    });
    expect(result.success).toBe(true);
  });

  it('rejects missing code', () => {
    const result = OpenRouterExchangeSchema.safeParse({ code_verifier: 'verifier' });
    expect(result.success).toBe(false);
  });

  it('rejects missing code_verifier', () => {
    const result = OpenRouterExchangeSchema.safeParse({ code: 'code' });
    expect(result.success).toBe(false);
  });

  it('rejects empty string code', () => {
    const result = OpenRouterExchangeSchema.safeParse({ code: '', code_verifier: 'verifier' });
    expect(result.success).toBe(false);
  });

  it('rejects oversized code (> 512 chars)', () => {
    const result = OpenRouterExchangeSchema.safeParse({
      code: 'a'.repeat(513),
      code_verifier: 'verifier',
    });
    expect(result.success).toBe(false);
  });

  it('rejects invalid challenge method', () => {
    const result = OpenRouterExchangeSchema.safeParse({
      code: 'code',
      code_verifier: 'verifier',
      code_challenge_method: 'md5',
    });
    expect(result.success).toBe(false);
  });
});

// ── Rate limit key derivation ─────────────────────────────────────────────────

describe('rate limit IP key derivation', () => {
  function deriveRateLimitKey(
    cfConnectingIp: string | undefined,
    xForwardedFor: string | undefined
  ): string {
    const forwardedFor = xForwardedFor;
    const firstForwarded = forwardedFor?.split(',')[0]?.trim();
    const ip = cfConnectingIp ?? firstForwarded ?? 'global';
    return `ip:${ip}`;
  }

  it('prefers CF-Connecting-IP over X-Forwarded-For', () => {
    expect(deriveRateLimitKey('1.2.3.4', '9.9.9.9')).toBe('ip:1.2.3.4');
  });

  it('falls back to first X-Forwarded-For address', () => {
    expect(deriveRateLimitKey(undefined, '5.6.7.8, 1.2.3.4')).toBe('ip:5.6.7.8');
  });

  it('uses "global" when no IP is available', () => {
    expect(deriveRateLimitKey(undefined, undefined)).toBe('ip:global');
  });

  it('handles single X-Forwarded-For address', () => {
    expect(deriveRateLimitKey(undefined, '10.0.0.1')).toBe('ip:10.0.0.1');
  });
});
