import type { PaperEngine } from '../../services/paper-engine.js';
import type { Env } from '../../types/env.js';

/**
 * Minimal agent row fields cached in DO storage.
 * Updated on every /start and /sync-config call so agent-loop can skip the D1 read.
 */
export type CachedAgentRow = {
  id: string;
  name: string;
  status: string;
  config: string;
  ownerAddress: string | null;
  llmModel: string | null;
  profileId: string | null;
  personaMd: string | null;
};

export type SerializedEngineState = ReturnType<PaperEngine['serialize']>;

export type TradingAgentRuntime = {
  ctx: DurableObjectState;
  env: Env;
  broadcast(message: object): void;
  rescheduleAlarmIfRunning(): Promise<void>;
};
