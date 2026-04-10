<script setup lang="ts">
import { useRoute } from 'vue-router';
import { useManagerDetailPage } from '~/features/managers/detail/useManagerDetailPage';
import ManagerHeaderSection from '~/components/manager-detail/ManagerHeaderSection.vue';
import ManagerStatsSection from '~/components/manager-detail/ManagerStatsSection.vue';
import ManagerLogsSection from '~/components/manager-detail/ManagerLogsSection.vue';
import ManagerAgentsSection from '~/components/manager-detail/ManagerAgentsSection.vue';

const route = useRoute();
const id = route.params.id as string;

const {
  pending,
  manager,
  doStatus,
  managedAgents,
  logs,
  totalTokensUsed,
  actionLoading,
  showDeleteModal,
  deleteAgentsChoice,
  nextDecisionLabel,
  progressPct,
  showMdPreview,
  expandedSections,
  logPage,
  totalLogPages,
  pagedLogs,
  personaEmoji,
  statusBadgeClass,
  shortModel,
  maxDrawdownLabel,
  init,
  triggerDecision,
  doDelete,
  doAction,
  toggleSection,
  maybeLoadMore,
  managerPrompt,
  agentBadgeClass,
  actionBadgeClass,
  sectionHtml,
} = useManagerDetailPage(id);

// Synchronous clear for poll timers etc is handled in onUnmounted within the composable.

await init();
</script>

<template>
  <main class="page">
    <div v-if="pending && !manager" class="page-loader">
      <div class="page-loader-track">
        <span class="page-loader-block" /><span class="page-loader-block" /><span class="page-loader-block" /><span class="page-loader-block" />
        <span class="page-loader-block" /><span class="page-loader-block" /><span class="page-loader-block" /><span class="page-loader-block" />
      </div>
      <span class="page-loader-label">Loading manager</span>
    </div>

    <template v-else-if="manager">
      <ManagerHeaderSection
        :manager="manager"
        :persona-emoji="personaEmoji"
        :status-badge-class="statusBadgeClass"
        :action-loading="actionLoading"
        :deciding="!!doStatus?.deciding"
        :last-decision-ms="doStatus?.lastDecisionMs ?? undefined"
        @action="doAction"
        @trigger="triggerDecision"
        @delete="showDeleteModal = true"
      />

      <ManagerStatsSection
        :manager="manager"
        :short-model="shortModel"
        :do-status="doStatus"
        :max-drawdown-label="maxDrawdownLabel"
        :total-tokens-used="totalTokensUsed"
        :next-decision-label="nextDecisionLabel"
        :progress-pct="progressPct"
      />

      <div class="detail-columns">
        <div class="detail-col-left">
          <ManagerLogsSection
            v-model:show-md-preview="showMdPreview"
            :logs="logs"
            :paged-logs="pagedLogs"
            :expanded-sections="expandedSections"
            :log-page="logPage"
            :total-log-pages="totalLogPages"
            :has-more-logs="false"
            :section-html="sectionHtml"
            :manager-prompt="managerPrompt"
            :action-badge-class="actionBadgeClass"
            @toggle-section="toggleSection"
            @change-page="(p) => { logPage = p; maybeLoadMore(); }"
          />
        </div>

        <div class="detail-col-right">
          <ManagerAgentsSection
            :managed-agents="managedAgents"
            :agent-badge-class="agentBadgeClass"
          />
        </div>
      </div>
    </template>

    <div v-else class="alert alert-error">Manager not found.</div>

    <!-- Delete confirmation modal -->
    <div v-if="showDeleteModal" class="modal-overlay" @click.self="showDeleteModal = false">
      <div class="modal">
        <h2 class="modal-title">Delete manager?</h2>
        <p class="modal-hint">
          <strong class="text-normal">{{ manager?.name }}</strong> will be permanently deleted along with its decision log.
        </p>
        <div v-if="managedAgents.length > 0" class="delete-agents-choice">
          <p class="choice-text">
            This manager has <strong class="text-normal">{{ managedAgents.length }} agent{{ managedAgents.length !== 1 ? 's' : '' }}</strong>. What should happen to them?
          </p>
          <label class="radio-row">
            <input v-model="deleteAgentsChoice" type="radio" value="detach" />
            <span>Keep agents — detach them from this manager</span>
          </label>
          <label class="radio-row">
            <input v-model="deleteAgentsChoice" type="radio" value="delete" />
            <span class="text-danger">Delete agents too</span>
          </label>
        </div>
        <div class="modal-footer">
          <button class="btn btn-ghost" @click="showDeleteModal = false">Cancel</button>
          <button class="btn btn-danger" :disabled="actionLoading" @click="doDelete">
            {{ actionLoading ? 'Deleting…' : 'Delete' }}
          </button>
        </div>
      </div>
    </div>
  </main>
</template>

<style scoped>
.detail-columns {
  display: grid;
  grid-template-columns: minmax(0, 2fr) minmax(280px, 1fr);
  gap: 20px;
  align-items: start;
}

@media (max-width: 1080px) {
  .detail-columns { grid-template-columns: 1fr; }
}

/* Modal styles kept here as they are page-level UI state */
.modal-hint { font-size: 14px; color: var(--text-dim); margin-bottom: 16px; }
.text-normal { color: var(--text); }
.text-danger { color: var(--red); }

.delete-agents-choice {
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 12px 14px;
  margin-bottom: 16px;
}
.choice-text { font-size: 13px; color: var(--text-muted); margin-bottom: 10px; }
.radio-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: var(--text-dim);
  cursor: pointer;
  padding: 4px 0;
}
.radio-row input { cursor: pointer; accent-color: var(--accent); }
</style>
