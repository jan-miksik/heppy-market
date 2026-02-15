<script setup lang="ts">
definePageMeta({ ssr: false });
const { agents, loading, error, fetchAgents, createAgent, startAgent, stopAgent, deleteAgent } = useAgents();
const router = useRouter();

const showCreateModal = ref(false);
const creating = ref(false);
const createError = ref('');

onMounted(fetchAgents);

async function handleCreate(payload: Parameters<typeof createAgent>[0]) {
  creating.value = true;
  createError.value = '';
  try {
    const agent = await createAgent(payload);
    showCreateModal.value = false;
    router.push(`/agents/${agent.id}`);
  } catch (e) {
    createError.value = String(e);
  } finally {
    creating.value = false;
  }
}

async function handleDelete(id: string) {
  if (!confirm('Delete this agent? This cannot be undone.')) return;
  try {
    await deleteAgent(id);
  } catch (e) {
    alert(`Failed to delete: ${e}`);
  }
}
</script>

<template>
  <main class="page">
    <div class="page-header">
      <div>
        <h1 class="page-title">Trading Agents</h1>
        <p class="page-subtitle">{{ agents.length }} agents · {{ agents.filter(a => a.status === 'running').length }} running</p>
      </div>
      <button class="btn btn-primary" @click="showCreateModal = true">
        + New Agent
      </button>
    </div>

    <div v-if="loading" style="text-align: center; padding: 48px;">
      <span class="spinner" />
    </div>

    <div v-else-if="error" class="alert alert-error">{{ error }}</div>

    <div v-else-if="agents.length === 0" class="empty-state">
      <div class="empty-icon">🤖</div>
      <div class="empty-title">No agents yet</div>
      <p>Create your first AI trading agent to get started.</p>
      <button class="btn btn-primary" style="margin-top: 16px;" @click="showCreateModal = true">
        Create Agent
      </button>
    </div>

    <div v-else class="agents-grid">
      <AgentCard
        v-for="agent in agents"
        :key="agent.id"
        :agent="agent"
        @click="$router.push(`/agents/${agent.id}`)"
        @start="startAgent"
        @stop="stopAgent"
        @delete="handleDelete"
      />
    </div>

    <!-- Create Modal -->
    <Teleport to="body">
      <div v-if="showCreateModal" class="modal-overlay" @click.self="showCreateModal = false">
        <div class="modal">
          <div class="modal-header">
            <span class="modal-title">Create Trading Agent</span>
            <button class="btn btn-ghost btn-sm" @click="showCreateModal = false">✕</button>
          </div>
          <div class="modal-body">
            <div v-if="createError" class="alert alert-error">{{ createError }}</div>
            <AgentConfigForm
              @submit="handleCreate"
              @cancel="showCreateModal = false"
            />
          </div>
        </div>
      </div>
    </Teleport>
  </main>
</template>
