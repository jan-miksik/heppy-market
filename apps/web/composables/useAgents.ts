/**
 * Agents composable — CRUD operations and state management for trading agents.
 */

const AGENTS_TTL = 15 * 60 * 1000; // 15 min
const AGENTS_KEY = 'agents';

export interface Agent {
  id: string;
  name: string;
  status: 'running' | 'stopped' | 'paused';
  autonomyLevel: 'full' | 'guided' | 'strict';
  llmModel: string;
  config: {
    pairs: string[];
    paperBalance: number;
    strategies: string[];
    analysisInterval: string;
    maxPositionSizePct: number;
    stopLossPct: number;
    takeProfitPct: number;
    maxOpenPositions: number;
    slippageSimulation: number;
    temperature: number;
    allowFallback?: boolean;
    behavior?: Record<string, unknown>;
  };
  managerId?: string | null;
  profileId?: string | null;
  personaMd?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateAgentPayload {
  name: string;
  autonomyLevel: 'full' | 'guided' | 'strict';
  autoApplySelfModification?: boolean;
  selfModCooldownCycles?: number;
  pairs?: string[];
  paperBalance?: number;
  strategies?: string[];
  analysisInterval?: string;
  maxPositionSizePct?: number;
  stopLossPct?: number;
  takeProfitPct?: number;
  maxOpenPositions?: number;
  llmModel?: string;
  allowFallback?: boolean;
  temperature?: number;
  behavior?: Record<string, unknown>;
  profileId?: string;
  personaMd?: string;
}

export function useAgents() {
  const { request } = useApi();
  const cache = useClientCache();

  const agents = ref<Agent[]>([]);
  const loading = ref(false);
  const error = ref<string | null>(null);

  async function fetchAgents() {
    loading.value = true;
    error.value = null;
    try {
      const cached = cache.get<{ agents: Agent[] }>(AGENTS_KEY);
      if (cached) {
        agents.value = cached.agents;
        return;
      }
      const res = await request<{ agents: Agent[] }>('/api/agents');
      cache.set(AGENTS_KEY, res, AGENTS_TTL);
      agents.value = res.agents;
    } catch (e) {
      error.value = extractApiError(e);
    } finally {
      loading.value = false;
    }
  }

  async function createAgent(payload: CreateAgentPayload): Promise<Agent> {
    const agent = await request<Agent>('/api/agents', {
      method: 'POST',
      body: payload,
    });
    cache.invalidate(AGENTS_KEY);
    agents.value = [agent, ...agents.value];
    return agent;
  }

  async function getAgent(id: string): Promise<Agent> {
    return request<Agent>(`/api/agents/${id}`);
  }

  async function startAgent(id: string): Promise<void> {
    await request(`/api/agents/${id}/start`, { method: 'POST' });
    cache.invalidate(AGENTS_KEY);
    const agent = agents.value.find((a) => a.id === id);
    if (agent) agent.status = 'running';
  }

  async function stopAgent(id: string): Promise<void> {
    await request(`/api/agents/${id}/stop`, { method: 'POST' });
    cache.invalidate(AGENTS_KEY);
    const agent = agents.value.find((a) => a.id === id);
    if (agent) agent.status = 'stopped';
  }

  async function pauseAgent(id: string): Promise<void> {
    await request(`/api/agents/${id}/pause`, { method: 'POST' });
    cache.invalidate(AGENTS_KEY);
    const agent = agents.value.find((a) => a.id === id);
    if (agent) agent.status = 'paused';
  }

  async function deleteAgent(id: string): Promise<void> {
    await request(`/api/agents/${id}`, { method: 'DELETE' });
    cache.invalidate(AGENTS_KEY);
    agents.value = agents.value.filter((a) => a.id !== id);
  }

  async function updateAgent(id: string, payload: Partial<CreateAgentPayload>): Promise<Agent> {
    const agent = await request<Agent>(`/api/agents/${id}`, {
      method: 'PATCH',
      body: payload,
    });
    cache.invalidate(AGENTS_KEY);
    const idx = agents.value.findIndex((a) => a.id === id);
    if (idx >= 0) agents.value.splice(idx, 1, agent);
    return agent;
  }

  return {
    agents,
    loading,
    error,
    fetchAgents,
    createAgent,
    getAgent,
    startAgent,
    stopAgent,
    pauseAgent,
    deleteAgent,
    updateAgent,
  };
}
