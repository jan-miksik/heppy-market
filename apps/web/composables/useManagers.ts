const MANAGERS_TTL = 15 * 60 * 1000;
const MANAGERS_KEY = 'managers';
const MANAGER_DETAIL_PREFIX = 'manager:detail:';
const MANAGER_AGENTS_PREFIX = 'manager:agents:';
const MANAGER_LOGS_PREFIX = 'manager:logs:';
const MANAGER_TOKEN_USAGE_PREFIX = 'manager:token-usage:';

export interface ManagerSummary {
  id: string;
  name: string;
  status: 'running' | 'stopped' | 'paused' | string;
  profileId?: string | null;
  agentCount?: number;
  createdAt: string;
  updatedAt?: string;
  config: {
    llmModel?: string;
    decisionInterval?: string;
    profileId?: string;
    riskParams?: {
      maxTotalDrawdown?: number;
      maxAgents?: number;
      maxCorrelatedPositions?: number;
    };
  } | null;
}

export interface ManagerDetail extends ManagerSummary {
  ownerAddress?: string;
  personaMd?: string | null;
  doStatus?: {
    deciding?: boolean;
    lastDecisionAt?: number | null;
    lastDecisionMs?: number | null;
    decisionInterval?: string;
    tickCount?: number;
    nextAlarmAt?: number | null;
  };
}

export interface ManagedAgentSummary {
  id: string;
  name: string;
  status: string;
  profileId?: string | null;
  config?: {
    pairs?: string[];
    profileId?: string | null;
  };
}

export interface ManagerLogEntry {
  id: string;
  action: string;
  reasoning: string;
  createdAt: string;
  result?: Record<string, unknown> | null;
  llmPromptTokens?: number | null;
  llmCompletionTokens?: number | null;
}

export function useManagers() {
  const { request } = useApi();
  const cache = useClientCache();

  const managers = ref<ManagerSummary[]>([]);
  const loading = ref(false);
  const error = ref<string | null>(null);

  async function fetchManagers(opts?: { force?: boolean }): Promise<ManagerSummary[]> {
    loading.value = true;
    error.value = null;
    try {
      const cached = opts?.force ? null : cache.get<{ managers: ManagerSummary[] }>(MANAGERS_KEY);
      if (cached && !opts?.force) {
        managers.value = cached.managers;
        return cached.managers;
      }

      const res = await request<{ managers: ManagerSummary[] }>('/api/managers');
      cache.set(MANAGERS_KEY, res, MANAGERS_TTL);
      managers.value = res.managers;
      return res.managers;
    } catch (e) {
      error.value = extractApiError(e);
      throw e;
    } finally {
      loading.value = false;
    }
  }

  async function getManager(id: string, opts?: { force?: boolean }): Promise<ManagerDetail> {
    const key = `${MANAGER_DETAIL_PREFIX}${id}`;
    const cached = opts?.force ? null : cache.get<ManagerDetail>(key);
    if (cached && !opts?.force) return cached;

    const manager = await request<ManagerDetail>(`/api/managers/${id}`, {
      ...(opts?.force ? { fresh: true } : {}),
    });
    cache.set(key, manager, MANAGERS_TTL);
    return manager;
  }

  async function getManagerAgents(id: string, opts?: { force?: boolean }): Promise<ManagedAgentSummary[]> {
    const key = `${MANAGER_AGENTS_PREFIX}${id}`;
    const cached = opts?.force ? null : cache.get<{ agents: ManagedAgentSummary[] }>(key);
    if (cached && !opts?.force) return cached.agents;

    const res = await request<{ agents: ManagedAgentSummary[] }>(`/api/managers/${id}/agents`, {
      ...(opts?.force ? { fresh: true } : {}),
    });
    cache.set(key, res, MANAGERS_TTL);
    return res.agents;
  }

  async function getManagerLogs(
    id: string,
    params?: { page?: number; limit?: number; force?: boolean },
  ): Promise<{ logs: ManagerLogEntry[]; page: number; limit: number }> {
    const page = params?.page ?? 1;
    const limit = params?.limit ?? 20;
    const key = `${MANAGER_LOGS_PREFIX}${id}:page=${page}:limit=${limit}`;
    const cached = params?.force ? null : cache.get<{ logs: ManagerLogEntry[]; page: number; limit: number }>(key);
    if (cached && !params?.force) return cached;

    const query = new URLSearchParams({ page: String(page), limit: String(limit) });
    const res = await request<{ logs: ManagerLogEntry[]; page: number; limit: number }>(
      `/api/managers/${id}/logs?${query.toString()}`,
      { ...(params?.force ? { fresh: true } : {}) },
    );
    cache.set(key, res, 30_000);
    return res;
  }

  async function getManagerTokenUsage(id: string, opts?: { force?: boolean }): Promise<number> {
    const key = `${MANAGER_TOKEN_USAGE_PREFIX}${id}`;
    const cached = opts?.force ? null : cache.get<{ totalTokens: number }>(key);
    if (cached && !opts?.force) return cached.totalTokens;

    const res = await request<{ totalTokens: number }>(`/api/managers/${id}/token-usage`, {
      ...(opts?.force ? { fresh: true } : {}),
    });
    cache.set(key, res, MANAGERS_TTL);
    return res.totalTokens;
  }

  async function createManager(payload: Record<string, unknown>): Promise<ManagerSummary> {
    const manager = await request<ManagerSummary>('/api/managers', { method: 'POST', body: payload });
    cache.invalidate(MANAGERS_KEY);
    managers.value = [manager, ...managers.value];
    return manager;
  }

  async function updateManager(id: string, payload: Record<string, unknown>): Promise<ManagerDetail> {
    const manager = await request<ManagerDetail>(`/api/managers/${id}`, { method: 'PATCH', body: payload });
    cache.invalidate(MANAGERS_KEY);
    cache.invalidate(`${MANAGER_DETAIL_PREFIX}${id}`);
    return manager;
  }

  async function deleteManager(id: string, opts?: { deleteAgents?: boolean }): Promise<void> {
    const suffix = opts?.deleteAgents ? '?deleteAgents=true' : '';
    await request(`/api/managers/${id}${suffix}`, { method: 'DELETE' });
    cache.invalidate(MANAGERS_KEY);
    cache.invalidate(`${MANAGER_DETAIL_PREFIX}${id}`);
    cache.invalidate(`${MANAGER_AGENTS_PREFIX}${id}`);
    cache.invalidatePrefix(`${MANAGER_LOGS_PREFIX}${id}`);
    cache.invalidate(`${MANAGER_TOKEN_USAGE_PREFIX}${id}`);
    managers.value = managers.value.filter((m) => m.id !== id);
  }

  async function startManager(id: string): Promise<void> {
    await request(`/api/managers/${id}/start`, { method: 'POST' });
    cache.invalidate(MANAGERS_KEY);
    cache.invalidate(`${MANAGER_DETAIL_PREFIX}${id}`);
  }

  async function stopManager(id: string): Promise<void> {
    await request(`/api/managers/${id}/stop`, { method: 'POST' });
    cache.invalidate(MANAGERS_KEY);
    cache.invalidate(`${MANAGER_DETAIL_PREFIX}${id}`);
  }

  async function pauseManager(id: string): Promise<void> {
    await request(`/api/managers/${id}/pause`, { method: 'POST' });
    cache.invalidate(MANAGERS_KEY);
    cache.invalidate(`${MANAGER_DETAIL_PREFIX}${id}`);
  }

  async function triggerManager(id: string): Promise<void> {
    await request(`/api/managers/${id}/trigger`, { method: 'POST', timeout: 30_000 });
    cache.invalidate(`${MANAGER_DETAIL_PREFIX}${id}`);
    cache.invalidatePrefix(`${MANAGER_LOGS_PREFIX}${id}`);
  }

  return {
    managers,
    loading,
    error,
    fetchManagers,
    getManager,
    getManagerAgents,
    getManagerLogs,
    getManagerTokenUsage,
    createManager,
    updateManager,
    deleteManager,
    startManager,
    stopManager,
    pauseManager,
    triggerManager,
  };
}
