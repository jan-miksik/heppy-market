/**
 * Agents composable — CRUD operations and state management for trading agents.
 */
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
  createdAt: string;
  updatedAt: string;
}

export interface CreateAgentPayload {
  name: string;
  autonomyLevel: 'full' | 'guided' | 'strict';
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

  const agents = ref<Agent[]>([]);
  const loading = ref(false);
  const error = ref<string | null>(null);

  async function fetchAgents() {
    loading.value = true;
    error.value = null;
    try {
      const res = await request<{ agents: Agent[] }>('/api/agents');
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
    agents.value = [agent, ...agents.value];
    return agent;
  }

  async function getAgent(id: string): Promise<Agent> {
    return request<Agent>(`/api/agents/${id}`);
  }

  async function startAgent(id: string): Promise<void> {
    await request(`/api/agents/${id}/start`, { method: 'POST' });
    const idx = agents.value.findIndex((a) => a.id === id);
    if (idx >= 0) agents.value[idx].status = 'running';
  }

  async function stopAgent(id: string): Promise<void> {
    await request(`/api/agents/${id}/stop`, { method: 'POST' });
    const idx = agents.value.findIndex((a) => a.id === id);
    if (idx >= 0) agents.value[idx].status = 'stopped';
  }

  async function pauseAgent(id: string): Promise<void> {
    await request(`/api/agents/${id}/pause`, { method: 'POST' });
    const idx = agents.value.findIndex((a) => a.id === id);
    if (idx >= 0) agents.value[idx].status = 'paused';
  }

  async function deleteAgent(id: string): Promise<void> {
    await request(`/api/agents/${id}`, { method: 'DELETE' });
    agents.value = agents.value.filter((a) => a.id !== id);
  }

  async function updateAgent(id: string, payload: Partial<CreateAgentPayload>): Promise<Agent> {
    const agent = await request<Agent>(`/api/agents/${id}`, {
      method: 'PATCH',
      body: payload,
    });
    const idx = agents.value.findIndex((a) => a.id === id);
    if (idx >= 0) agents.value[idx] = agent;
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
