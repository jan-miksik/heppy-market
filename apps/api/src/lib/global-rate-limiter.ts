/**
 * GlobalRateLimiterDO — Durable Object for atomic per-user LLM rate limiting.
 *
 * One DO instance per userId (via idFromName(userId)). Because DOs process
 * requests sequentially, counter increments are inherently atomic — no race
 * conditions possible unlike the KV-based limiter.
 *
 * Tracks:
 *   - requests per minute  (LLM_PER_MINUTE)
 *   - requests per hour    (LLM_PER_HOUR)
 *
 * Storage: counters are stored in DO storage so they survive evictions.
 * Windows are fixed-width (aligned to clock minute/hour) and auto-reset.
 */
import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../types/env.js';

/** Hard limits — intentionally generous for regular users, protect against runaway agents */
export const LLM_LIMIT_PER_MINUTE = 10;
export const LLM_LIMIT_PER_HOUR   = 120;

interface WindowCounter {
  count: number;
  windowStart: number; // Unix timestamp (seconds), beginning of the current window
}

export interface RateLimitCheckResult {
  allowed: boolean;
  /** 'minute' or 'hour' — which limit was hit (only set when !allowed) */
  limitedBy?: 'minute' | 'hour';
  minuteRemaining: number;
  hourRemaining: number;
  minuteResetAt: number; // Unix seconds
  hourResetAt: number;   // Unix seconds
}

/** Duration of each window in seconds */
const MINUTE_WINDOW = 60;
const HOUR_WINDOW   = 3_600;

export class GlobalRateLimiterDO extends DurableObject<Env> {
  // In-memory cache to avoid redundant storage reads within the same request
  private minute: WindowCounter | null = null;
  private hour:   WindowCounter | null = null;

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/check' && request.method === 'POST') {
      const result = await this.checkAndIncrement();
      return Response.json(result, { status: result.allowed ? 200 : 429 });
    }

    if (url.pathname === '/status') {
      const result = await this.peekStatus();
      return Response.json(result);
    }

    if (url.pathname === '/reset' && request.method === 'POST') {
      await this.resetCounters();
      return Response.json({ ok: true });
    }

    return new Response('Not Found', { status: 404 });
  }

  /** Atomically check limits and increment if allowed */
  private async checkAndIncrement(): Promise<RateLimitCheckResult> {
    const nowSec = Math.floor(Date.now() / 1000);

    const [min, hr] = await Promise.all([
      this.loadCounter('minute', MINUTE_WINDOW, nowSec),
      this.loadCounter('hour', HOUR_WINDOW, nowSec),
    ]);

    const minuteResetAt = min.windowStart + MINUTE_WINDOW;
    const hourResetAt   = hr.windowStart  + HOUR_WINDOW;

    if (min.count >= LLM_LIMIT_PER_MINUTE) {
      return {
        allowed: false,
        limitedBy: 'minute',
        minuteRemaining: 0,
        hourRemaining: Math.max(0, LLM_LIMIT_PER_HOUR - hr.count),
        minuteResetAt,
        hourResetAt,
      };
    }

    if (hr.count >= LLM_LIMIT_PER_HOUR) {
      return {
        allowed: false,
        limitedBy: 'hour',
        minuteRemaining: Math.max(0, LLM_LIMIT_PER_MINUTE - min.count),
        hourRemaining: 0,
        minuteResetAt,
        hourResetAt,
      };
    }

    // Allowed — increment both counters
    min.count++;
    hr.count++;
    await Promise.all([
      this.ctx.storage.put('minute', min),
      this.ctx.storage.put('hour', hr),
    ]);
    this.minute = min;
    this.hour   = hr;

    return {
      allowed: true,
      minuteRemaining: Math.max(0, LLM_LIMIT_PER_MINUTE - min.count),
      hourRemaining:   Math.max(0, LLM_LIMIT_PER_HOUR   - hr.count),
      minuteResetAt,
      hourResetAt,
    };
  }

  /** Read current status without incrementing */
  private async peekStatus(): Promise<RateLimitCheckResult> {
    const nowSec = Math.floor(Date.now() / 1000);
    const [min, hr] = await Promise.all([
      this.loadCounter('minute', MINUTE_WINDOW, nowSec),
      this.loadCounter('hour', HOUR_WINDOW, nowSec),
    ]);

    return {
      allowed: min.count < LLM_LIMIT_PER_MINUTE && hr.count < LLM_LIMIT_PER_HOUR,
      minuteRemaining: Math.max(0, LLM_LIMIT_PER_MINUTE - min.count),
      hourRemaining:   Math.max(0, LLM_LIMIT_PER_HOUR   - hr.count),
      minuteResetAt:   min.windowStart + MINUTE_WINDOW,
      hourResetAt:     hr.windowStart  + HOUR_WINDOW,
    };
  }

  /** Load a window counter from storage, resetting if the window has passed */
  private async loadCounter(
    key: 'minute' | 'hour',
    windowSecs: number,
    nowSec: number
  ): Promise<WindowCounter> {
    // Use in-memory cache to avoid double reads within same request
    const cached = key === 'minute' ? this.minute : this.hour;
    const windowStart = Math.floor(nowSec / windowSecs) * windowSecs;

    if (cached && cached.windowStart === windowStart) return cached;

    const stored = await this.ctx.storage.get<WindowCounter>(key);
    let counter: WindowCounter;

    if (!stored || stored.windowStart !== windowStart) {
      // New window — reset counter
      counter = { count: 0, windowStart };
    } else {
      counter = stored;
    }

    if (key === 'minute') this.minute = counter;
    else this.hour = counter;

    return counter;
  }

  private async resetCounters(): Promise<void> {
    this.minute = null;
    this.hour = null;
    await Promise.all([
      this.ctx.storage.delete('minute'),
      this.ctx.storage.delete('hour'),
    ]);
  }
}

/**
 * Check LLM rate limit for a given userId via GlobalRateLimiterDO.
 * Returns the result; caller decides whether to proceed or return 429.
 *
 * Usage:
 *   const result = await checkLlmRateLimit(env, userId);
 *   if (!result.allowed) return error(429, ...);
 */
export async function checkLlmRateLimit(
  env: Env,
  userId: string
): Promise<RateLimitCheckResult> {
  const stub = env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName(userId));
  const res = await stub.fetch(new Request('http://do/check', { method: 'POST' }));
  return res.json() as Promise<RateLimitCheckResult>;
}
