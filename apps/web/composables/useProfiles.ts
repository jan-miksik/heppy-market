export interface ProfileItem {
  id: string;
  name: string;
  emoji: string;
  description: string;
  type: 'agent' | 'manager';
  category: 'preset' | 'custom';
  isPreset: boolean;
  behaviorConfig: Record<string, unknown>;
}

export function useProfiles() {
  const { request } = useApi();

  async function listProfiles(type?: 'agent' | 'manager'): Promise<ProfileItem[]> {
    const url = type ? `/api/profiles?type=${type}` : '/api/profiles';
    const data = await request<{ profiles: ProfileItem[] }>(url);
    return data.profiles;
  }

  async function getAgentPersona(agentId: string) {
    return request<{ personaMd: string | null; profileId: string | null }>(`/api/agents/${agentId}/persona`);
  }

  async function updateAgentPersona(agentId: string, personaMd: string) {
    return request<{ ok: boolean; personaMd: string }>(`/api/agents/${agentId}/persona`, {
      method: 'PUT',
      body: JSON.stringify({ personaMd }),
    });
  }

  async function resetAgentPersona(agentId: string) {
    return request<{ ok: boolean; personaMd: string }>(`/api/agents/${agentId}/persona/reset`, {
      method: 'POST',
    });
  }

  async function getManagerPersona(managerId: string) {
    return request<{ personaMd: string | null; profileId: string | null }>(`/api/managers/${managerId}/persona`);
  }

  async function updateManagerPersona(managerId: string, personaMd: string) {
    return request<{ ok: boolean; personaMd: string }>(`/api/managers/${managerId}/persona`, {
      method: 'PUT',
      body: JSON.stringify({ personaMd }),
    });
  }

  async function resetManagerPersona(managerId: string) {
    return request<{ ok: boolean; personaMd: string }>(`/api/managers/${managerId}/persona/reset`, {
      method: 'POST',
    });
  }

  return {
    listProfiles,
    getAgentPersona,
    updateAgentPersona,
    resetAgentPersona,
    getManagerPersona,
    updateManagerPersona,
    resetManagerPersona,
  };
}
