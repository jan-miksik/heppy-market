import type { CachedAgentRow } from './types.js';

export async function syncCachedAgentRow(
  storage: DurableObjectStorage,
  agentRow: CachedAgentRow,
  statusOverride?: string,
): Promise<void> {
  await storage.put('cachedAgentRow', {
    ...agentRow,
    status: statusOverride ?? agentRow.status,
  });
}

export async function updateCachedAgentStatus(storage: DurableObjectStorage, status: string): Promise<void> {
  const cached = await storage.get<CachedAgentRow>('cachedAgentRow');
  if (cached) {
    await storage.put('cachedAgentRow', { ...cached, status });
  }
}

export async function clearPriceMisses(storage: DurableObjectStorage): Promise<void> {
  const priceMissKeys = await storage.list({ prefix: 'priceMiss:' });
  for (const key of priceMissKeys.keys()) {
    await storage.delete(key);
  }
}
