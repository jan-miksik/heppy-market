import { PaperEngine } from '../../services/paper-engine.js';
import type { SerializedEngineState } from './types.js';

export const DEFAULT_BALANCE = 10_000;
export const DEFAULT_SLIPPAGE = 0.3;
export const LOOP_LOCK_TTL_MS = 10 * 60_000;
export const PENDING_LLM_TTL_MS = 5 * 60_000;

export function createPaperEngine(options?: { balance?: number; slippage?: number }): PaperEngine {
  return new PaperEngine({
    balance: options?.balance ?? DEFAULT_BALANCE,
    slippage: options?.slippage ?? DEFAULT_SLIPPAGE,
  });
}

export async function loadEngine(storage: DurableObjectStorage): Promise<PaperEngine> {
  const engineState = await storage.get<SerializedEngineState>('engineState');
  return engineState ? PaperEngine.deserialize(engineState) : createPaperEngine();
}

export async function persistEngineState(
  storage: DurableObjectStorage,
  engine: PaperEngine,
  errorContext: string,
): Promise<void> {
  try {
    await storage.put('engineState', engine.serialize());
  } catch (err) {
    console.error(`[TradingAgentDO] ${errorContext}:`, err);
  }
}
