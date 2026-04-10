import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../types/env.js';
import { migrateStorage } from '../lib/do-storage-migration.js';
import { handleAlarm, rescheduleAlarmIfRunning } from './trading-agent/alarms.js';
import { handleTradingAgentRequest } from './trading-agent/endpoints.js';
import { broadcastToSockets, handleWebSocketClose, handleWebSocketError, handleWebSocketMessage } from './trading-agent/websocket.js';
import type { TradingAgentRuntime } from './trading-agent/types.js';
export type { CachedAgentRow } from './trading-agent/types.js';

/**
 * TradingAgentDO — Durable Object managing a single trading agent instance.
 *
 * Persistent state (via ctx.storage):
 * - agentId: string
 * - status: 'running' | 'stopped' | 'paused'
 * - engineState: serialized PaperEngine state
 * - lastStopOutAt: timestamp of last stop-out (for cooldown)
 *
 * The alarm fires on each analysis interval tick and runs the full agent loop.
 */
export class TradingAgentDO extends DurableObject<Env> {
  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
  }

  async fetch(request: Request): Promise<Response> {
    // Run any pending DO storage migrations on every request.
    // migrateStorage() exits immediately when already at current version (fast path).
    await migrateStorage(this.ctx.storage).catch((err) => {
      console.warn('[TradingAgentDO] storage migration failed (non-fatal):', err);
    });

    const response = await handleTradingAgentRequest(this.runtime, request);
    if (response) {
      return response;
    }

    return new Response('Not Found', { status: 404 });
  }

  /** Broadcast a JSON message to all connected WebSocket clients. */
  private broadcast(message: object): void {
    broadcastToSockets(this.ctx, message);
  }

  // ── Hibernatable WebSocket handlers ───────────────────────────────────────

  async webSocketMessage(_ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    await handleWebSocketMessage(_ws, message);
  }

  async webSocketClose(ws: WebSocket, code: number, _reason: string, _wasClean: boolean): Promise<void> {
    await handleWebSocketClose(ws, code, _reason, _wasClean);
  }

  async webSocketError(_ws: WebSocket, _error: unknown): Promise<void> {
    await handleWebSocketError(_ws, _error);
  }

  async alarm(): Promise<void> {
    await handleAlarm(this.runtime);
  }

  /** Reschedule the next alarm if the agent is still in 'running' status. */
  private async rescheduleAlarmIfRunning(): Promise<void> {
    await rescheduleAlarmIfRunning(this.runtime);
  }

  private get runtime(): TradingAgentRuntime {
    return {
      ctx: this.ctx,
      env: this.env,
      broadcast: (message: object) => this.broadcast(message),
      rescheduleAlarmIfRunning: () => this.rescheduleAlarmIfRunning(),
    };
  }
}
