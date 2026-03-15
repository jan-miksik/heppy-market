export interface SelfModification {
  id: string;
  agentId: string;
  decisionId: string | null;
  reason: string;
  changes: Record<string, unknown>;
  changesApplied: Record<string, unknown> | null;
  status: 'pending' | 'applied' | 'rejected';
  appliedAt: string | null;
  createdAt: string;
}

export function useSelfModifications() {
  const { request } = useApi();

  const modifications = ref<SelfModification[]>([]);
  const loading = ref(false);

  async function fetchModifications(agentId: string) {
    loading.value = true;
    try {
      const data = await request<{ modifications: SelfModification[] }>(
        `/api/agents/${agentId}/self-modifications`,
      );
      modifications.value = data.modifications;
    } finally {
      loading.value = false;
    }
  }

  async function approve(agentId: string, modId: string) {
    await request(`/api/agents/${agentId}/self-modifications/${modId}/approve`, {
      method: 'POST',
    });
    const mod = modifications.value.find((m) => m.id === modId);
    if (mod) mod.status = 'applied';
  }

  async function reject(agentId: string, modId: string) {
    await request(`/api/agents/${agentId}/self-modifications/${modId}/reject`, {
      method: 'POST',
    });
    const mod = modifications.value.find((m) => m.id === modId);
    if (mod) mod.status = 'rejected';
  }

  const pendingModifications = computed(() =>
    modifications.value.filter((m) => m.status === 'pending'),
  );

  const modDecisionIds = computed(
    () => new Set(modifications.value.map((m) => m.decisionId).filter(Boolean)),
  );

  return {
    modifications,
    loading,
    pendingModifications,
    modDecisionIds,
    fetchModifications,
    approve,
    reject,
  };
}
