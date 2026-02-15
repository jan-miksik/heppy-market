import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../types/env.js';

/**
 * TradingAgentDO — Durable Object for managing a single trading agent instance.
 * Each agent gets its own DO with persistent state, an alarm-based analysis loop,
 * and access to D1 / KV / LLM services via the Worker env.
 *
 * Phase 1: stub implementation (only handles HTTP requests).
 * Phase 3/4: full agent loop will be added.
 */
export class TradingAgentDO extends DurableObject<Env> {
  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/status') {
      const agentId = (await this.ctx.storage.get<string>('agentId')) ?? null;
      const status = (await this.ctx.storage.get<string>('status')) ?? 'stopped';
      return Response.json({ agentId, status });
    }

    if (url.pathname === '/start' && request.method === 'POST') {
      const body = (await request.json()) as { agentId: string };
      await this.ctx.storage.put('agentId', body.agentId);
      await this.ctx.storage.put('status', 'running');
      // Schedule first alarm
      const now = Date.now();
      await this.ctx.storage.setAlarm(now + 5_000); // first tick in 5s
      return Response.json({ ok: true, status: 'running' });
    }

    if (url.pathname === '/stop' && request.method === 'POST') {
      await this.ctx.storage.put('status', 'stopped');
      await this.ctx.storage.deleteAlarm();
      return Response.json({ ok: true, status: 'stopped' });
    }

    if (url.pathname === '/pause' && request.method === 'POST') {
      await this.ctx.storage.put('status', 'paused');
      await this.ctx.storage.deleteAlarm();
      return Response.json({ ok: true, status: 'paused' });
    }

    return new Response('Not Found', { status: 404 });
  }

  async alarm(): Promise<void> {
    const status = (await this.ctx.storage.get<string>('status')) ?? 'stopped';
    if (status !== 'running') return;

    // Phase 4: full agent loop runs here
    // For now, just reschedule
    const intervalMs = 60_000; // default 1m, will be read from config in phase 4
    await this.ctx.storage.setAlarm(Date.now() + intervalMs);
  }
}
