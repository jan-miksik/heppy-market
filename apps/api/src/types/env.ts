import type { TradingAgentDO } from '../agents/trading-agent.js';

/** Cloudflare Worker environment bindings */
export interface Env {
  DB: D1Database;
  CACHE: KVNamespace;
  TRADING_AGENT: DurableObjectNamespace<TradingAgentDO>;
  OPENROUTER_API_KEY: string;
  ANTHROPIC_API_KEY?: string;
  /** Optional comma-separated origins for CORS (e.g. production Pages URL). Merged with default allowlist. */
  CORS_ORIGINS?: string;
}
