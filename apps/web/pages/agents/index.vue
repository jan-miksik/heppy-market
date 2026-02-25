<script setup lang="ts">
definePageMeta({ ssr: false });
const { agents, loading, error, fetchAgents, createAgent, startAgent, stopAgent, deleteAgent, updateAgent } = useAgents();
const router = useRouter();

const userAgents = computed(() => agents.value.filter((a) => !a.managerId));
const managedAgents = computed(() => agents.value.filter((a) => !!a.managerId));

const showCreateModal = ref(false);
const creating = ref(false);
const createError = ref('');

const editingAgent = ref<(typeof agents.value)[0] | null>(null);
const showEditModal = ref(false);
const saving = ref(false);
const saveError = ref('');

onMounted(fetchAgents);

async function handleCreate(payload: Parameters<typeof createAgent>[0]) {
  creating.value = true;
  createError.value = '';
  try {
    const agent = await createAgent(payload);
    // Auto-start the agent after creation
    try {
      await startAgent(agent.id);
    } catch {
      // Non-fatal — agent created but failed to start
      console.warn('Agent created but failed to auto-start');
    }
    showCreateModal.value = false;
    router.push(`/agents/${agent.id}`);
  } catch (e) {
    createError.value = extractApiError(e);
  } finally {
    creating.value = false;
  }
}

async function handleDelete(id: string) {
  if (!confirm('Delete this agent? This cannot be undone.')) return;
  try {
    await deleteAgent(id);
  } catch (e) {
    alert(`Failed to delete: ${extractApiError(e)}`);
  }
}

function handleEditClick(id: string) {
  const found = agents.value.find((a) => a.id === id) ?? null;
  editingAgent.value = found;
  saveError.value = '';
  showEditModal.value = true;
}

async function handleEditSubmit(payload: Parameters<typeof updateAgent>[1]) {
  if (!editingAgent.value) return;
  saving.value = true;
  saveError.value = '';
  try {
    await updateAgent(editingAgent.value.id, payload);
    showEditModal.value = false;
    editingAgent.value = null;
  } catch (e) {
    saveError.value = extractApiError(e);
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <main class="page">
    <div class="page-header">
      <div>
        <h1 class="page-title">Trading Agents</h1>
        <p class="page-subtitle">{{ agents.length }} agents · {{ agents.filter(a => a.status === 'running').length }} running<span v-if="managedAgents.length"> · {{ managedAgents.length }} managed</span></p>
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

    <div v-else>
      <!-- User-created agents -->
      <div v-if="userAgents.length > 0">
        <div v-if="managedAgents.length > 0" class="section-header">Your agents</div>
        <div class="agents-grid">
          <AgentCard
            v-for="agent in userAgents"
            :key="agent.id"
            :agent="agent"
            @click="$router.push(`/agents/${agent.id}`)"
            @start="startAgent"
            @stop="stopAgent"
            @delete="handleDelete"
            @edit="handleEditClick"
          />
        </div>
      </div>

      <!-- Manager-created agents -->
      <div v-if="managedAgents.length > 0" :style="userAgents.length > 0 ? 'margin-top: 28px;' : ''">
        <div class="section-header">
          <span>Managed by Agent Manager</span>
          <span class="section-count">{{ managedAgents.length }}</span>
        </div>
        <div class="agents-grid">
          <AgentCard
            v-for="agent in managedAgents"
            :key="agent.id"
            :agent="agent"
            @click="$router.push(`/agents/${agent.id}`)"
            @start="startAgent"
            @stop="stopAgent"
            @delete="handleDelete"
            @edit="handleEditClick"
          />
        </div>
      </div>
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

    <!-- Edit Modal -->
    <Teleport to="body">
      <div v-if="showEditModal && editingAgent" class="modal-overlay" @click.self="showEditModal = false">
        <div class="modal">
          <div class="modal-header">
            <span class="modal-title">Edit Agent</span>
            <button class="btn btn-ghost btn-sm" @click="showEditModal = false">✕</button>
          </div>
          <div class="modal-body">
            <div v-if="saveError" class="alert alert-error">{{ saveError }}</div>
            <AgentConfigForm
              :initialValues="{
                name: editingAgent.name,
                autonomyLevel: editingAgent.autonomyLevel,
                llmModel: editingAgent.llmModel,
                pairs: editingAgent.config.pairs,
                paperBalance: editingAgent.config.paperBalance,
                strategies: editingAgent.config.strategies,
                analysisInterval: editingAgent.config.analysisInterval,
                maxPositionSizePct: editingAgent.config.maxPositionSizePct,
                stopLossPct: editingAgent.config.stopLossPct,
                takeProfitPct: editingAgent.config.takeProfitPct,
                maxOpenPositions: editingAgent.config.maxOpenPositions,
                temperature: editingAgent.config.temperature ?? 0.7,
                allowFallback: editingAgent.config.allowFallback ?? false,
              }"
              @submit="handleEditSubmit"
              @cancel="showEditModal = false"
            />
          </div>
          <div v-if="editingAgent.status === 'running'" class="modal-bottom-warning">Agent is running — changes take effect on the next analysis cycle.</div>
        </div>
      </div>
    </Teleport>
  </main>
</template>

<style scoped>
.section-header {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-muted);
  margin-bottom: 12px;
}
.section-count {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  border-radius: 9px;
  background: var(--bg-card);
  border: 1px solid var(--border);
  font-size: 11px;
  font-weight: 600;
  color: var(--text-dim);
}
</style>
