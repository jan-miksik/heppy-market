import { type Context, type Hono } from 'hono';
import { drizzle } from 'drizzle-orm/d1';
import { eq } from 'drizzle-orm';
import type { Env } from '../../types/env.js';
import type { AuthVariables } from '../../lib/auth.js';
import { agents, trades, agentDecisions, performanceSnapshots, agentSelfModifications } from '../../db/schema.js';
import { registerSchedulerAgent, unregisterSchedulerAgent } from '../../lib/do-clients.js';
import { parseJsonObjectOrEmpty, parseJsonOrNull, parseJsonRequired } from '../../lib/json.js';

export type AgentsContext = Context<{ Bindings: Env; Variables: AuthVariables }>;
export type AgentsRoute = Hono<{ Bindings: Env; Variables: AuthVariables }>;
export type AgentsDb = ReturnType<typeof drizzle>;
export type AgentRow = typeof agents.$inferSelect;

export function parseAgentConfig(raw: string): Record<string, unknown> {
  return parseJsonRequired<Record<string, unknown>>(raw);
}

export function formatAgent(r: AgentRow) {
  return {
    ...r,
    config: parseAgentConfig(r.config),
    initiaSyncState: r.initiaSyncState ? parseJsonOrNull<Record<string, unknown>>(r.initiaSyncState) : null,
  };
}

export function normalizeInitiaWalletAddress(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.toLowerCase();
}

export function parseInitiaSyncState(raw: string | null): Record<string, unknown> {
  return parseJsonObjectOrEmpty(raw);
}

export function getTradingAgentStub(env: Env, agentId: string) {
  const doId = env.TRADING_AGENT.idFromName(agentId);
  return env.TRADING_AGENT.get(doId);
}

export async function deleteAgentRelatedRows(db: AgentsDb, agentId: string): Promise<void> {
  await db.delete(trades).where(eq(trades.agentId, agentId));
  await db.delete(agentDecisions).where(eq(agentDecisions.agentId, agentId));
  await db.delete(performanceSnapshots).where(eq(performanceSnapshots.agentId, agentId));
  await db.delete(agentSelfModifications).where(eq(agentSelfModifications.agentId, agentId));
}

/** Shared ownership check: agent must belong to the authenticated wallet. */
export async function requireOwnership(
  db: AgentsDb,
  id: string,
  walletAddress: string
): Promise<AgentRow | null> {
  const [agent] = await db.select().from(agents).where(eq(agents.id, id));
  if (!agent) return null;
  if (!agent.ownerAddress) return null;
  if (agent.ownerAddress.toLowerCase() !== walletAddress.toLowerCase()) return null;
  return agent;
}

export function agentNotFound(c: AgentsContext): Response {
  return c.json({ error: 'Agent not found' }, 404);
}

export async function withOwnedAgent(
  c: AgentsContext,
  handler: (params: {
    id: string;
    walletAddress: string;
    db: AgentsDb;
    agent: AgentRow;
  }) => Promise<Response>
): Promise<Response> {
  const id = c.req.param('id');
  const walletAddress = c.get('walletAddress');
  const db = drizzle(c.env.DB);
  const agent = await requireOwnership(db, id, walletAddress);
  if (!agent) return agentNotFound(c);
  return handler({ id, walletAddress, db, agent });
}

/** Best-effort: register or unregister an agent with the global scheduler DO. */
export async function notifyScheduler(
  env: Env,
  action: 'register' | 'unregister',
  agentId: string,
  interval?: string
): Promise<void> {
  try {
    if (action === 'register') {
      await registerSchedulerAgent(env, { agentId, interval: interval ?? '1h' });
    } else {
      await unregisterSchedulerAgent(env, agentId);
    }
  } catch (err) {
    console.warn(`[agents route] scheduler ${action} failed for ${agentId}:`, err);
  }
}
