import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../../types/env.js';
import { migrateStorage } from '../../lib/do-storage-migration.js';
import { handleAlarm, rescheduleAlarmIfRunning } from './alarms.js';
import { handleTradingAgentRequest } from './endpoints.js';
import { broadcastToSockets, handleWebSocketClose, handleWebSocketError, handleWebSocketMessage } from './websocket.js';
import type { TradingAgentRuntime } from './types.js';

export type { CachedAgentRow } from './types.js';

export class TradingAgentDO extends DurableObject<Env> {
  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
  }

  async fetch(request: Request): Promise<Response> {
    await migrateStorage(this.ctx.storage).catch((err) => {
      console.warn('[TradingAgentDO] storage migration failed (non-fatal):', err);
    });

    const response = await handleTradingAgentRequest(this.runtime, request);
    if (response) {
      return response;
    }

    return new Response('Not Found', { status: 404 });
  }

  private broadcast(message: object): void {
    broadcastToSockets(this.ctx, message);
  }

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
