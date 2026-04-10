import type { TradingAgentRuntime } from './types.js';

export function broadcastToSockets(ctx: DurableObjectState, message: object): void {
  const json = JSON.stringify(message);
  for (const ws of ctx.getWebSockets()) {
    try {
      ws.send(json);
    } catch {
      // Client WS is closed or errored; runtime will clean it up.
    }
  }
}

export async function handleWebSocketUpgrade(runtime: TradingAgentRuntime): Promise<Response> {
  const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];
  const agentId = (await runtime.ctx.storage.get<string>('agentId')) ?? 'unknown';
  runtime.ctx.acceptWebSocket(server, [`agent:${agentId}`]);

  const engineState = await runtime.ctx.storage.get<{ balance?: number; positions?: unknown[] }>('engineState');
  const status = (await runtime.ctx.storage.get<string>('status')) ?? 'stopped';
  server.send(JSON.stringify({
    type: 'snapshot',
    agentId,
    status,
    balance: engineState?.balance ?? null,
    openPositions: engineState?.positions?.length ?? 0,
  }));

  return new Response(null, { status: 101, webSocket: client });
}

export async function handleWebSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
  const text = typeof message === 'string' ? message : new TextDecoder().decode(message);
  if (text === 'ping') ws.send('pong');
}

export async function handleWebSocketClose(
  ws: WebSocket,
  code: number,
  _reason: string,
  _wasClean: boolean,
): Promise<void> {
  ws.close(code, 'Connection closed');
}

export async function handleWebSocketError(_ws: WebSocket, _error: unknown): Promise<void> {
  // CF runtime removes errored WS from getWebSockets() automatically.
}
