import { type Context, type Hono } from 'hono';
import { drizzle } from 'drizzle-orm/d1';
import { eq } from 'drizzle-orm';
import type { Env } from '../../types/env.js';
import type { AuthVariables } from '../../lib/auth.js';
import { agentManagers } from '../../db/schema.js';
import { parseJsonOr, parseJsonRequired } from '../../lib/json.js';

export type ManagersContext = Context<{ Bindings: Env; Variables: AuthVariables }>;
export type ManagersRoute = Hono<{ Bindings: Env; Variables: AuthVariables }>;
export type ManagersDb = ReturnType<typeof drizzle>;
export type ManagerRow = typeof agentManagers.$inferSelect;

export function parseManagerConfig(raw: string): Record<string, unknown> {
  return parseJsonRequired<Record<string, unknown>>(raw);
}

export function formatManager(r: ManagerRow) {
  return {
    ...r,
    config: parseManagerConfig(r.config),
  };
}

export function safeParseManagerLogResult(raw: string): Record<string, unknown> | null {
  const parsed = parseJsonOr<unknown>(raw, null);
  return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
}

export async function requireManagerOwnership(
  db: ManagersDb,
  id: string,
  walletAddress: string
): Promise<ManagerRow | null> {
  const [manager] = await db.select().from(agentManagers).where(eq(agentManagers.id, id));
  if (!manager) return null;
  if (manager.ownerAddress !== walletAddress) return null;
  return manager;
}

export function managerNotFound(c: ManagersContext): Response {
  return c.json({ error: 'Manager not found' }, 404);
}

export async function withOwnedManager(
  c: ManagersContext,
  handler: (params: { id: string; walletAddress: string; db: ManagersDb; manager: ManagerRow }) => Promise<Response>
): Promise<Response> {
  const id = c.req.param('id');
  const walletAddress = c.get('walletAddress');
  const db = drizzle(c.env.DB);
  const manager = await requireManagerOwnership(db, id, walletAddress);
  if (!manager) return managerNotFound(c);
  return handler({ id, walletAddress, db, manager });
}
