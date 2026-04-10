import { type Context, type Hono } from 'hono';
import { drizzle } from 'drizzle-orm/d1';
import { eq } from 'drizzle-orm';
import type { Env } from '../../types/env.js';
import type { AuthVariables } from '../../lib/auth.js';
import { agentManagers } from '../../db/schema.js';
import { formatStoredEntity } from '../_shared/format-stored-entity.js';
import { notFoundJson } from '../_shared/json-response.js';
import { requireOwnedEntity } from '../_shared/owned-entity.js';
import { parseStoredJson, parseStoredJsonOr } from '../_shared/parse-stored-json.js';

export type ManagersContext = Context<{ Bindings: Env; Variables: AuthVariables }>;
export type ManagersRoute = Hono<{ Bindings: Env; Variables: AuthVariables }>;
export type ManagersDb = ReturnType<typeof drizzle>;
export type ManagerRow = typeof agentManagers.$inferSelect;

export function parseManagerConfig(raw: string): Record<string, unknown> {
  return parseStoredJson<Record<string, unknown>>(raw);
}

export function formatManager(r: ManagerRow) {
  return formatStoredEntity(r, {
    config: parseManagerConfig,
  });
}

export function safeParseManagerLogResult(raw: string): Record<string, unknown> | null {
  const parsed = parseStoredJsonOr<unknown>(raw, null);
  return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
}

export async function requireManagerOwnership(
  db: ManagersDb,
  id: string,
  walletAddress: string
): Promise<ManagerRow | null> {
  return requireOwnedEntity(
    db,
    id,
    walletAddress,
    async (database, managerId) => {
      const [manager] = await database.select().from(agentManagers).where(eq(agentManagers.id, managerId));
      return manager ?? null;
    },
    (manager) => manager.ownerAddress,
  );
}

export function managerNotFound(c: ManagersContext): Response {
  return notFoundJson(c, 'Manager');
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
