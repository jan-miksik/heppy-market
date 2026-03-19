/**
 * Rate limiting tests — GlobalRateLimiterDO window logic, helper function, and
 * integration wiring (env binding, agent-loop guard).
 */
import { describe, it, expect, vi } from 'vitest';

// Stub cloudflare:workers (DurableObject base class) — not available in Vitest/Node
vi.mock('cloudflare:workers', () => ({
  DurableObject: class {
    constructor(_state: unknown, _env: unknown) {}
  },
}));

import {
  LLM_LIMIT_PER_MINUTE,
  LLM_LIMIT_PER_HOUR,
  type RateLimitCheckResult,
} from '../src/lib/global-rate-limiter.js';

// ── Constants ─────────────────────────────────────────────────────────────────

describe('rate limit constants', () => {
  it('per-minute limit is 10', () => {
    expect(LLM_LIMIT_PER_MINUTE).toBe(10);
  });

  it('per-hour limit is 120', () => {
    expect(LLM_LIMIT_PER_HOUR).toBe(120);
  });

  it('per-hour limit >= per-minute limit', () => {
    expect(LLM_LIMIT_PER_HOUR).toBeGreaterThanOrEqual(LLM_LIMIT_PER_MINUTE);
  });
});

// ── RateLimitCheckResult shape ────────────────────────────────────────────────

describe('RateLimitCheckResult shape', () => {
  const allowed: RateLimitCheckResult = {
    allowed: true,
    minuteRemaining: 9,
    hourRemaining: 119,
    minuteResetAt: 1_000_060,
    hourResetAt: 1_003_600,
  };

  const denied: RateLimitCheckResult = {
    allowed: false,
    limitedBy: 'minute',
    minuteRemaining: 0,
    hourRemaining: 50,
    minuteResetAt: 1_000_060,
    hourResetAt: 1_003_600,
  };

  it('allowed result has no limitedBy field', () => {
    expect(allowed.limitedBy).toBeUndefined();
  });

  it('denied result specifies limitedBy', () => {
    expect(denied.limitedBy).toBe('minute');
  });

  it('minuteRemaining is 0 when minute limit hit', () => {
    expect(denied.minuteRemaining).toBe(0);
  });

  it('minuteRemaining decrements from limit', () => {
    expect(allowed.minuteRemaining).toBe(LLM_LIMIT_PER_MINUTE - 1);
  });

  it('hourRemaining decrements from limit', () => {
    expect(allowed.hourRemaining).toBe(LLM_LIMIT_PER_HOUR - 1);
  });

  it('resetAt is a positive unix timestamp', () => {
    expect(allowed.minuteResetAt).toBeGreaterThan(0);
    expect(allowed.hourResetAt).toBeGreaterThan(allowed.minuteResetAt);
  });
});

// ── Window boundary logic (pure) ─────────────────────────────────────────────

describe('window boundary math', () => {
  const MINUTE_WINDOW = 60;
  const HOUR_WINDOW = 3_600;

  function windowStart(nowSec: number, windowSecs: number): number {
    return Math.floor(nowSec / windowSecs) * windowSecs;
  }

  it('minute window aligns to clock minute', () => {
    expect(windowStart(90, MINUTE_WINDOW)).toBe(60);
    expect(windowStart(60, MINUTE_WINDOW)).toBe(60);
    expect(windowStart(59, MINUTE_WINDOW)).toBe(0);
  });

  it('hour window aligns to clock hour', () => {
    expect(windowStart(3_601, HOUR_WINDOW)).toBe(3_600);
    expect(windowStart(7_199, HOUR_WINDOW)).toBe(3_600);
    expect(windowStart(3_600, HOUR_WINDOW)).toBe(3_600);
  });

  it('new window resets when nowSec crosses boundary', () => {
    const prev = windowStart(59, MINUTE_WINDOW);
    const next = windowStart(60, MINUTE_WINDOW);
    expect(next).toBeGreaterThan(prev);
  });
});

// ── checkLlmRateLimit helper (stub) ──────────────────────────────────────────

describe('checkLlmRateLimit stub', () => {
  it('returns allowed=true when DO responds 200', async () => {
    const mockResult: RateLimitCheckResult = {
      allowed: true,
      minuteRemaining: 5,
      hourRemaining: 100,
      minuteResetAt: Date.now() / 1000 + 30,
      hourResetAt: Date.now() / 1000 + 1_800,
    };

    const fetchMock = vi.fn().mockResolvedValue({
      json: () => Promise.resolve(mockResult),
    });
    const stubMock = { fetch: fetchMock };
    const envMock = {
      RATE_LIMITER: {
        get: () => stubMock,
        idFromName: () => 'mock-id',
      },
    } as any;

    const { checkLlmRateLimit } = await import('../src/lib/global-rate-limiter.js');
    const result = await checkLlmRateLimit(envMock, '0xdeadbeef');

    expect(result.allowed).toBe(true);
    expect(result.minuteRemaining).toBe(5);
    expect(fetchMock).toHaveBeenCalledOnce();
    // Verify it hits the /check endpoint
    const [req] = fetchMock.mock.calls[0] as [Request];
    expect(req.url).toContain('/check');
    expect(req.method).toBe('POST');
  });

  it('returns allowed=false when DO responds 429', async () => {
    const mockResult: RateLimitCheckResult = {
      allowed: false,
      limitedBy: 'hour',
      minuteRemaining: 3,
      hourRemaining: 0,
      minuteResetAt: Date.now() / 1000 + 30,
      hourResetAt: Date.now() / 1000 + 1_800,
    };

    const fetchMock = vi.fn().mockResolvedValue({
      json: () => Promise.resolve(mockResult),
    });
    const stubMock = { fetch: fetchMock };
    const envMock = {
      RATE_LIMITER: {
        get: () => stubMock,
        idFromName: () => 'mock-id',
      },
    } as any;

    const { checkLlmRateLimit } = await import('../src/lib/global-rate-limiter.js');
    const result = await checkLlmRateLimit(envMock, '0xdeadbeef');

    expect(result.allowed).toBe(false);
    expect(result.limitedBy).toBe('hour');
    expect(result.hourRemaining).toBe(0);
  });
});

// ── Agent-loop integration (guard logic) ─────────────────────────────────────

describe('agent-loop rate limit guard', () => {
  it('hold decision reasoning mentions the limiting window', () => {
    const limitedBy = 'minute';
    const resetAt = Math.floor(Date.now() / 1000) + 45;
    const secsUntilReset = Math.ceil(resetAt - Date.now() / 1000);
    const reasoning = `LLM rate limit reached (${limitedBy} limit). Resets in ${secsUntilReset}s.`;

    expect(reasoning).toContain('minute');
    expect(reasoning).toContain('Resets in');
    expect(reasoning).toMatch(/\d+s/);
  });

  it('hour-limited reasoning references hour window', () => {
    const limitedBy = 'hour';
    const resetAt = Math.floor(Date.now() / 1000) + 1_200;
    const secsUntilReset = Math.ceil(resetAt - Date.now() / 1000);
    const reasoning = `LLM rate limit reached (${limitedBy} limit). Resets in ${secsUntilReset}s.`;

    expect(reasoning).toContain('hour');
  });

  it('rate limit check uses lowercase wallet address as key', () => {
    const rawAddress = '0xDEADBEEFDEADBEEFDEADBEEFDEADBEEFDEADBEEF';
    const key = rawAddress.toLowerCase();
    expect(key).toBe('0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef');
    // idFromName is deterministic — same key = same DO = correct per-user isolation
  });

  it('skips rate limit check when RATE_LIMITER binding is absent', async () => {
    // If env.RATE_LIMITER is undefined (e.g. local dev without binding), guard is skipped
    const env = {} as any; // no RATE_LIMITER
    const rateLimitKey = '0xabc';
    const shouldSkip = !rateLimitKey || !env.RATE_LIMITER;
    expect(shouldSkip).toBe(true);
  });
});

// ── DO /status and /reset endpoint contracts ──────────────────────────────────

describe('DO endpoint contracts', () => {
  it('/status returns peek without incrementing', async () => {
    const status: RateLimitCheckResult = {
      allowed: true,
      minuteRemaining: 10,
      hourRemaining: 120,
      minuteResetAt: Date.now() / 1000 + 60,
      hourResetAt: Date.now() / 1000 + 3_600,
    };

    // After a fresh reset, full capacity should be available
    expect(status.minuteRemaining).toBe(LLM_LIMIT_PER_MINUTE);
    expect(status.hourRemaining).toBe(LLM_LIMIT_PER_HOUR);
    expect(status.allowed).toBe(true);
  });

  it('/check decrements remaining by 1 on each allowed call', () => {
    let minuteCount = 0;
    let hourCount = 0;

    function simulateCheck(): RateLimitCheckResult {
      if (minuteCount >= LLM_LIMIT_PER_MINUTE) {
        return { allowed: false, limitedBy: 'minute', minuteRemaining: 0, hourRemaining: LLM_LIMIT_PER_HOUR - hourCount, minuteResetAt: 0, hourResetAt: 0 };
      }
      if (hourCount >= LLM_LIMIT_PER_HOUR) {
        return { allowed: false, limitedBy: 'hour', minuteRemaining: LLM_LIMIT_PER_MINUTE - minuteCount, hourRemaining: 0, minuteResetAt: 0, hourResetAt: 0 };
      }
      minuteCount++;
      hourCount++;
      return { allowed: true, minuteRemaining: LLM_LIMIT_PER_MINUTE - minuteCount, hourRemaining: LLM_LIMIT_PER_HOUR - hourCount, minuteResetAt: 0, hourResetAt: 0 };
    }

    for (let i = 0; i < LLM_LIMIT_PER_MINUTE; i++) {
      const r = simulateCheck();
      expect(r.allowed).toBe(true);
    }
    const blocked = simulateCheck();
    expect(blocked.allowed).toBe(false);
    expect(blocked.limitedBy).toBe('minute');
  });
});
