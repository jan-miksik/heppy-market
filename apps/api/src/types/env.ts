import type { TradingAgentDO } from '../agents/trading-agent.js';
import type { AgentManagerDO } from '../agents/agent-manager.js';
import type { GlobalRateLimiterDO } from '../lib/global-rate-limiter.js';

/** Cloudflare Worker environment bindings */
export interface Env {
  DB: D1Database;
  CACHE: KVNamespace;
  TRADING_AGENT: DurableObjectNamespace<TradingAgentDO>;
  AGENT_MANAGER: DurableObjectNamespace<AgentManagerDO>;
  RATE_LIMITER: DurableObjectNamespace<GlobalRateLimiterDO>;
  OPENROUTER_API_KEY: string;
  ANTHROPIC_API_KEY?: string;
  /** Optional comma-separated origins for CORS (e.g. production Pages URL). Merged with default allowlist. */
  CORS_ORIGINS?: string;
  /** Optional Base RPC URL for ERC-1271/ERC-6492 smart account signature verification. Falls back to public Base RPC. */
  BASE_RPC_URL?: string;
  /** 64-char hex (32 bytes). Used to AES-GCM encrypt user API keys at rest. If absent, keys stored plain (dev only). */
  KEY_ENCRYPTION_SECRET?: string;
  /** Dev/test only. When set, enables POST /api/auth/dev-session for Playwright. Never set in production. */
  PLAYWRIGHT_SECRET?: string;
}
