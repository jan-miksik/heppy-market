import { handleWebSocketUpgrade } from './websocket.js';
import { handleAnalyze, handleClearHistory, handleReset, handleSetInterval, handleSetStatus, handleStart, handleSyncConfig } from './endpoint-control.js';
import { handleDebug, handleEngineState, handleStatus } from './endpoint-inspection.js';
import { handleClosePosition, handleReceiveDecision } from './endpoint-trades.js';
import type { TradingAgentRuntime } from './types.js';

export async function handleTradingAgentRequest(
  runtime: TradingAgentRuntime,
  request: Request,
): Promise<Response | null> {
  const url = new URL(request.url);

  if (url.pathname === '/status') return handleStatus(runtime);
  if (url.pathname === '/start' && request.method === 'POST') return handleStart(runtime, request);
  if (url.pathname === '/analyze' && request.method === 'POST') return handleAnalyze(runtime, request);
  if (url.pathname === '/set-interval' && request.method === 'POST') return handleSetInterval(runtime, request);
  if (url.pathname === '/clear-history' && request.method === 'POST') return handleClearHistory(runtime, request);
  if (url.pathname === '/reset' && request.method === 'POST') return handleReset(runtime, request);
  if (url.pathname === '/stop' && request.method === 'POST') return handleSetStatus(runtime, 'stopped');
  if (url.pathname === '/pause' && request.method === 'POST') return handleSetStatus(runtime, 'paused');
  if (url.pathname === '/close-position' && request.method === 'POST') return handleClosePosition(runtime, request);
  if (url.pathname === '/engine-state') return handleEngineState(runtime);
  if (url.pathname === '/debug') return handleDebug(runtime);
  if (url.pathname === '/receive-decision' && request.method === 'POST') return handleReceiveDecision(runtime, request);
  if (url.pathname === '/sync-config' && request.method === 'POST') return handleSyncConfig(runtime, request);
  if (url.pathname === '/ws' && request.headers.get('Upgrade') === 'websocket') return handleWebSocketUpgrade(runtime);

  return null;
}
