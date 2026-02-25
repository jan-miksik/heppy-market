import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../types/env.js';
import { runManagerLoop } from './manager-loop.js';

function intervalToMs(interval: string): number {
  switch (interval) {
    case '1h': return 60 * 60_000;
    case '4h': return 4 * 60 * 60_000;
    case '1d': return 24 * 60 * 60_000;
    default:   return 60 * 60_000;
  }
}

export class AgentManagerDO extends DurableObject<Env> {
  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/status') {
      const managerId = (await this.ctx.storage.get<string>('managerId')) ?? null;
      const status = (await this.ctx.storage.get<string>('status')) ?? 'stopped';
      const tickCount = (await this.ctx.storage.get<number>('tickCount')) ?? 0;
      let nextAlarmAt = (await this.ctx.storage.get<number>('nextAlarmAt')) ?? null;
      const deciding = (await this.ctx.storage.get<boolean>('deciding')) ?? false;
      const lastDecisionAt = (await this.ctx.storage.get<number>('lastDecisionAt')) ?? null;
      const lastDecisionMs = (await this.ctx.storage.get<number>('lastDecisionMs')) ?? null;
      const memory = await this.ctx.storage.get('memory');

      // Auto-heal: if running but the alarm is more than 10s overdue and not currently
      // deciding, the alarm was likely lost (e.g. Wrangler restart in dev, or DO eviction).
      // Reschedule it to fire in 5s so the manager self-recovers without user intervention.
      if (status === 'running' && !deciding && nextAlarmAt !== null && nextAlarmAt < Date.now() - 10_000) {
        const healed = Date.now() + 5_000;
        await this.ctx.storage.put('nextAlarmAt', healed);
        await this.ctx.storage.setAlarm(healed);
        nextAlarmAt = healed;
        console.log(`[AgentManagerDO] ${managerId}: alarm was overdue — rescheduled in 5s`);
      }

      return Response.json({ managerId, status, tickCount, nextAlarmAt, deciding, lastDecisionAt, lastDecisionMs, hasMemory: !!memory });
    }

    if (url.pathname === '/start' && request.method === 'POST') {
      const body = (await request.json()) as { managerId: string; decisionInterval?: string };

      await this.ctx.storage.put('managerId', body.managerId);
      await this.ctx.storage.put('status', 'running');
      await this.ctx.storage.put('decisionInterval', body.decisionInterval ?? '1h');

      const intervalMs = intervalToMs(body.decisionInterval ?? '1h');
      const firstTick = Math.min(5_000, intervalMs);
      const nextAlarmAt = Date.now() + firstTick;
      await this.ctx.storage.put('nextAlarmAt', nextAlarmAt);
      await this.ctx.storage.setAlarm(nextAlarmAt);

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

    if (url.pathname === '/trigger' && request.method === 'POST') {
      const status = (await this.ctx.storage.get<string>('status')) ?? 'stopped';
      if (status !== 'running') {
        return Response.json({ error: 'Manager is not running' }, { status: 400 });
      }
      const deciding = (await this.ctx.storage.get<boolean>('deciding')) ?? false;
      if (deciding) {
        return Response.json({ error: 'Decision already in progress' }, { status: 409 });
      }
      // Reschedule alarm to fire in 1s
      const nextAlarmAt = Date.now() + 1_000;
      await this.ctx.storage.put('nextAlarmAt', nextAlarmAt);
      await this.ctx.storage.setAlarm(nextAlarmAt);
      return Response.json({ ok: true });
    }

    return new Response('Not Found', { status: 404 });
  }

  async alarm(): Promise<void> {
    const status = (await this.ctx.storage.get<string>('status')) ?? 'stopped';
    if (status !== 'running') return;

    const managerId = await this.ctx.storage.get<string>('managerId');
    if (!managerId) return;

    const tickCount = ((await this.ctx.storage.get<number>('tickCount')) ?? 0) + 1;
    await this.ctx.storage.put('tickCount', tickCount);
    await this.ctx.storage.put('deciding', true);
    const decisionStart = Date.now();

    try {
      await runManagerLoop(managerId, this.env, this.ctx);
    } catch (err) {
      console.error(`[AgentManagerDO] alarm error for ${managerId}:`, err);
    } finally {
      await this.ctx.storage.put('deciding', false);
      await this.ctx.storage.put('lastDecisionAt', Date.now());
      await this.ctx.storage.put('lastDecisionMs', Date.now() - decisionStart);
      try {
        const currentStatus = (await this.ctx.storage.get<string>('status')) ?? 'stopped';
        if (currentStatus === 'running') {
          const interval = (await this.ctx.storage.get<string>('decisionInterval')) ?? '1h';
          const nextAlarmAt = Date.now() + intervalToMs(interval);
          await this.ctx.storage.put('nextAlarmAt', nextAlarmAt);
          await this.ctx.storage.setAlarm(nextAlarmAt);
        }
      } catch (rescheduleErr) {
        console.error(`[AgentManagerDO] CRITICAL: failed to reschedule alarm for ${managerId}:`, rescheduleErr);
      }
    }
  }
}
