import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../types/env.js';
import { runManagerLoop } from './manager-loop.js';

const VALID_DECISION_INTERVALS = new Set(['1h', '4h', '1d']);
const VALID_SCHEDULER_INTERVALS = new Set(['1h', '4h', '1d']);

function normalizeDecisionInterval(interval: unknown, fallback = '1h'): string {
  if (typeof interval === 'string') {
    const normalized = interval.trim();
    if (VALID_DECISION_INTERVALS.has(normalized)) return normalized;
  }
  return fallback;
}

function intervalToMs(interval: string): number {
  switch (interval) {
    case '1h': return 60 * 60_000;
    case '4h': return 4 * 60 * 60_000;
    case '1d': return 24 * 60 * 60_000;
    default:   return 60 * 60_000;
  }
}

/** Storage key for scheduler agent registry (map of agentId → interval) */
const SCHEDULER_KEY = 'schedulerAgents';

/** Load the scheduler agent registry from DO storage */
async function loadSchedulerAgents(
  storage: DurableObjectStorage
): Promise<Record<string, string>> {
  const stored = await storage.get<Record<string, string>>(SCHEDULER_KEY);
  return stored ?? {};
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
      const decisionInterval = (await this.ctx.storage.get<string>('decisionInterval')) ?? null;
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

      return Response.json({
        managerId,
        status,
        decisionInterval,
        tickCount,
        nextAlarmAt,
        deciding,
        lastDecisionAt,
        lastDecisionMs,
        hasMemory: !!memory,
      });
    }

    if (url.pathname === '/start' && request.method === 'POST') {
      const body = (await request.json().catch(() => ({}))) as { managerId?: string; decisionInterval?: string };
      if (typeof body.managerId !== 'string' || body.managerId.trim().length === 0) {
        return Response.json({ error: 'managerId is required' }, { status: 400 });
      }
      const managerId = body.managerId.trim();
      const decisionInterval = normalizeDecisionInterval(body.decisionInterval, '1h');

      await this.ctx.storage.put('managerId', managerId);
      await this.ctx.storage.put('status', 'running');
      await this.ctx.storage.put('decisionInterval', decisionInterval);

      const intervalMs = intervalToMs(decisionInterval);
      const firstTick = Math.min(5_000, intervalMs);
      const nextAlarmAt = Date.now() + firstTick;
      await this.ctx.storage.put('nextAlarmAt', nextAlarmAt);
      await this.ctx.storage.setAlarm(nextAlarmAt);

      return Response.json({ ok: true, status: 'running' });
    }

    if (url.pathname === '/set-interval' && request.method === 'POST') {
      const body = (await request.json().catch(() => ({}))) as { decisionInterval?: string };
      const decisionInterval = typeof body.decisionInterval === 'string' ? body.decisionInterval.trim() : '';
      if (!VALID_DECISION_INTERVALS.has(decisionInterval)) {
        return Response.json(
          { error: 'decisionInterval must be one of: 1h, 4h, 1d' },
          { status: 400 },
        );
      }

      await this.ctx.storage.put('decisionInterval', decisionInterval);

      const status = (await this.ctx.storage.get<string>('status')) ?? 'stopped';
      if (status === 'running') {
        const nextAlarmAt = Date.now() + intervalToMs(decisionInterval);
        await this.ctx.storage.put('nextAlarmAt', nextAlarmAt);
        await this.ctx.storage.setAlarm(nextAlarmAt);
      }

      return Response.json({ ok: true, decisionInterval });
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
      const body = (await request.json().catch(() => ({}))) as { decisionInterval?: string };
      const requestedInterval = typeof body.decisionInterval === 'string' ? body.decisionInterval.trim() : '';
      if (requestedInterval) {
        if (!VALID_DECISION_INTERVALS.has(requestedInterval)) {
          return Response.json(
            { error: 'decisionInterval must be one of: 1h, 4h, 1d' },
            { status: 400 },
          );
        }
        await this.ctx.storage.put('decisionInterval', requestedInterval);
      }

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

    // ── Scheduler endpoints (used by cron handler + agent lifecycle routes) ──

    if (url.pathname === '/scheduler/register' && request.method === 'POST') {
      const body = (await request.json().catch(() => ({}))) as { agentId?: string; interval?: string };
      if (!body.agentId || !body.interval) {
        return Response.json({ error: 'agentId and interval are required' }, { status: 400 });
      }
      if (!VALID_SCHEDULER_INTERVALS.has(body.interval)) {
        return Response.json({ error: 'interval must be one of: 1h, 4h, 1d' }, { status: 400 });
      }
      const registry = await loadSchedulerAgents(this.ctx.storage);
      registry[body.agentId] = body.interval;
      await this.ctx.storage.put(SCHEDULER_KEY, registry);
      return Response.json({ ok: true, tracked: Object.keys(registry).length });
    }

    if (url.pathname === '/scheduler/unregister' && request.method === 'POST') {
      const body = (await request.json().catch(() => ({}))) as { agentId?: string };
      if (!body.agentId) {
        return Response.json({ error: 'agentId is required' }, { status: 400 });
      }
      const registry = await loadSchedulerAgents(this.ctx.storage);
      delete registry[body.agentId];
      await this.ctx.storage.put(SCHEDULER_KEY, registry);
      return Response.json({ ok: true, tracked: Object.keys(registry).length });
    }

    if (url.pathname === '/scheduler/agents') {
      const interval = url.searchParams.get('interval');
      const registry = await loadSchedulerAgents(this.ctx.storage);
      if (interval) {
        const filtered = Object.entries(registry)
          .filter(([, iv]) => iv === interval)
          .map(([id]) => id);
        return Response.json({ agentIds: filtered, total: filtered.length });
      }
      return Response.json({ registry, total: Object.keys(registry).length });
    }

    if (url.pathname === '/scheduler/list') {
      const registry = await loadSchedulerAgents(this.ctx.storage);
      return Response.json({ registry, total: Object.keys(registry).length });
    }

    if (url.pathname === '/scheduler/sync' && request.method === 'POST') {
      // Accepts an array of { agentId, interval } to rebuild the registry from D1
      const body = (await request.json().catch(() => ({}))) as { agents?: Array<{ agentId: string; interval: string }> };
      if (!Array.isArray(body.agents)) {
        return Response.json({ error: 'agents array is required' }, { status: 400 });
      }
      const registry: Record<string, string> = {};
      for (const { agentId, interval } of body.agents) {
        if (agentId && interval) registry[agentId] = interval;
      }
      await this.ctx.storage.put(SCHEDULER_KEY, registry);
      return Response.json({ ok: true, tracked: Object.keys(registry).length });
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
