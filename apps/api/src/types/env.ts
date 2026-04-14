import type { TradingAgentDO } from '../agents/trading-agent.js';
import type { AgentManagerDO } from '../agents/agent-manager.js';
import type { GlobalRateLimiterDO } from '../lib/global-rate-limiter.js';
import type { LlmJobMessage } from './queue-types.js';

/** Cloudflare Worker environment bindings */
export interface Env {
  DB: D1Database;
  CACHE: KVNamespace;
  TRADING_AGENT: DurableObjectNamespace<TradingAgentDO>;
  AGENT_MANAGER: DurableObjectNamespace<AgentManagerDO>;
  RATE_LIMITER: DurableObjectNamespace<GlobalRateLimiterDO>;
  /**
   * Cloudflare Queue binding for async LLM processing.
   * When present, the agent-loop enqueues LLM jobs here instead of calling the LLM inline.
   * Optional — if absent, the agent-loop falls back to the synchronous inline path.
   */
  LLM_QUEUE?: Queue<LlmJobMessage>;
  OPENROUTER_API_KEY: string;
  ANTHROPIC_API_KEY?: string;
  /** Optional comma-separated origins for CORS (e.g. production Pages URL). Merged with default allowlist. */
  CORS_ORIGINS?: string;
  /** Optional Base RPC URL for ERC-1271/ERC-6492 smart account signature verification. Falls back to public Base RPC. */
  BASE_RPC_URL?: string;
  /** Optional Initia EVM RPC URL for SIWE or other EVM verification on the rollup. */
  INITIA_EVM_RPC?: string;
  /** Optional Initia EVM chain id used by backend executor (defaults to local appchain id). */
  INITIA_EVM_CHAIN_ID?: string;
  /** Optional Agent contract address used by backend executor fallback when sync state does not have one. */
  INITIA_AGENT_CONTRACT_ADDRESS?: string;
  /** Optional private key used by backend executor to submit executeTick transactions. */
  INITIA_EXECUTOR_PRIVATE_KEY?: string;
  /** 64-char hex (32 bytes). Used to AES-GCM encrypt user API keys at rest. If absent, keys stored plain (dev only). */
  KEY_ENCRYPTION_SECRET?: string;
  /** Dev/test only. When set, enables POST /api/auth/dev-session for Playwright. Never set in production. */
  PLAYWRIGHT_SECRET?: string;
  /** Hackathon/dev only. When true, allows wallet-address session bootstrap without SIWE. */
  HACKATHON_AUTH_BYPASS?: string;
  /** Optional debug flag to log full LLM prompts/responses. Keep unset/false in production. */
  LOG_LLM_DEBUG?: string;
  /** Max agents one user can create. If unset, unlimited. */
  MAX_AGENTS_PER_USER?: string;
  /** Max managers one user can create. If unset, unlimited. */
  MAX_MANAGERS_PER_USER?: string;
  /** Default managed-agent limit for newly created managers. Falls back to 2 if unset. */
  DEFAULT_MANAGER_MAX_AGENTS?: string;
}
