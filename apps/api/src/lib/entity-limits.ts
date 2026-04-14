import type { Env } from '../types/env.js';

function parsePositiveIntegerLimit(value: string | undefined | null): number | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return null;

  return parsed;
}

export function getMaxAgentsPerUser(env: Pick<Env, 'MAX_AGENTS_PER_USER'>): number | null {
  return parsePositiveIntegerLimit(env.MAX_AGENTS_PER_USER);
}

export function getMaxManagersPerUser(env: Pick<Env, 'MAX_MANAGERS_PER_USER'>): number | null {
  return parsePositiveIntegerLimit(env.MAX_MANAGERS_PER_USER);
}

export function getDefaultManagerMaxAgents(env: Pick<Env, 'DEFAULT_MANAGER_MAX_AGENTS'>): number {
  return parsePositiveIntegerLimit(env.DEFAULT_MANAGER_MAX_AGENTS) ?? 2;
}
