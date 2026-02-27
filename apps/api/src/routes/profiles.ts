import { Hono } from 'hono';
import { drizzle } from 'drizzle-orm/d1';
import { eq } from 'drizzle-orm';
import type { Env } from '../types/env.js';
import type { AuthVariables } from '../lib/auth.js';
import { behaviorProfiles } from '../db/schema.js';
import { CreateBehaviorProfileSchema, AGENT_PROFILES, MANAGER_PROFILES } from '@dex-agents/shared';
import { validateBody } from '../lib/validation.js';
import { generateId, nowIso } from '../lib/utils.js';

const profilesRoute = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

function formatProfile(r: typeof behaviorProfiles.$inferSelect) {
  return {
    ...r,
    behaviorConfig: JSON.parse(r.behaviorConfig),
    isPreset: r.isPreset === 1,
  };
}

/** GET /api/profiles?type=agent|manager — list presets + custom */
profilesRoute.get('/', async (c) => {
  const typeFilter = c.req.query('type') as 'agent' | 'manager' | undefined;
  const db = drizzle(c.env.DB);

  const agentPresets = AGENT_PROFILES.map((p) => ({
    id: p.id,
    name: p.name,
    emoji: p.emoji,
    description: p.description,
    type: 'agent' as const,
    category: 'preset' as const,
    isPreset: true,
    behaviorConfig: p.behavior,
  }));
  const managerPresets = MANAGER_PROFILES.map((p) => ({
    id: p.id,
    name: p.name,
    emoji: p.emoji,
    description: p.description,
    type: 'manager' as const,
    category: 'preset' as const,
    isPreset: true,
    behaviorConfig: p.behavior,
  }));

  const customRows = await db.select().from(behaviorProfiles);
  const custom = customRows.map((r) => ({ ...formatProfile(r), category: 'custom' as const }));

  let all = [...agentPresets, ...managerPresets, ...custom];
  if (typeFilter) all = all.filter((p) => p.type === typeFilter);

  return c.json({ profiles: all });
});

/** POST /api/profiles — create custom profile */
profilesRoute.post('/', async (c) => {
  const body = await validateBody(c, CreateBehaviorProfileSchema);
  const db = drizzle(c.env.DB);

  const id = generateId('prof');
  const now = nowIso();

  await db.insert(behaviorProfiles).values({
    id,
    name: body.name,
    emoji: body.emoji ?? '🤖',
    description: body.description,
    type: body.type,
    behaviorConfig: JSON.stringify(body.behaviorConfig),
    isPreset: 0,
    createdAt: now,
    updatedAt: now,
  });

  const [created] = await db.select().from(behaviorProfiles).where(eq(behaviorProfiles.id, id));
  return c.json(formatProfile(created), 201);
});

/** GET /api/profiles/:id */
profilesRoute.get('/:id', async (c) => {
  const id = c.req.param('id');

  const agentPreset = AGENT_PROFILES.find((p) => p.id === id);
  if (agentPreset) {
    return c.json({ id: agentPreset.id, name: agentPreset.name, emoji: agentPreset.emoji, description: agentPreset.description, type: 'agent', isPreset: true, behaviorConfig: agentPreset.behavior });
  }
  const managerPreset = MANAGER_PROFILES.find((p) => p.id === id);
  if (managerPreset) {
    return c.json({ id: managerPreset.id, name: managerPreset.name, emoji: managerPreset.emoji, description: managerPreset.description, type: 'manager', isPreset: true, behaviorConfig: managerPreset.behavior });
  }

  const db = drizzle(c.env.DB);
  const [profile] = await db.select().from(behaviorProfiles).where(eq(behaviorProfiles.id, id));
  if (!profile) return c.json({ error: 'Profile not found' }, 404);
  return c.json(formatProfile(profile));
});

/** PATCH /api/profiles/:id — update custom (preset = 403) */
profilesRoute.patch('/:id', async (c) => {
  const id = c.req.param('id');

  const isPresetAgent = AGENT_PROFILES.some((p) => p.id === id);
  const isPresetManager = MANAGER_PROFILES.some((p) => p.id === id);
  if (isPresetAgent || isPresetManager) return c.json({ error: 'Cannot modify preset profiles' }, 403);

  const db = drizzle(c.env.DB);
  const [existing] = await db.select().from(behaviorProfiles).where(eq(behaviorProfiles.id, id));
  if (!existing) return c.json({ error: 'Profile not found' }, 404);
  if (existing.isPreset === 1) return c.json({ error: 'Cannot modify preset profiles' }, 403);

  const body = await c.req.json() as Record<string, unknown>;
  await db.update(behaviorProfiles).set({
    name: typeof body.name === 'string' ? body.name : existing.name,
    emoji: typeof body.emoji === 'string' ? body.emoji : existing.emoji,
    description: typeof body.description === 'string' ? body.description : existing.description,
    behaviorConfig: body.behaviorConfig ? JSON.stringify(body.behaviorConfig) : existing.behaviorConfig,
    updatedAt: nowIso(),
  }).where(eq(behaviorProfiles.id, id));

  const [updated] = await db.select().from(behaviorProfiles).where(eq(behaviorProfiles.id, id));
  return c.json(formatProfile(updated));
});

/** DELETE /api/profiles/:id */
profilesRoute.delete('/:id', async (c) => {
  const id = c.req.param('id');

  const isPreset = AGENT_PROFILES.some((p) => p.id === id) || MANAGER_PROFILES.some((p) => p.id === id);
  if (isPreset) return c.json({ error: 'Cannot delete preset profiles' }, 403);

  const db = drizzle(c.env.DB);
  const [existing] = await db.select().from(behaviorProfiles).where(eq(behaviorProfiles.id, id));
  if (!existing) return c.json({ error: 'Profile not found' }, 404);

  await db.delete(behaviorProfiles).where(eq(behaviorProfiles.id, id));
  return c.json({ ok: true });
});

export default profilesRoute;
