<script setup lang="ts">
import type { ManagerLog } from '~/features/managers/detail/useManagerDetailPage';

defineProps<{
  logs: ManagerLog[];
  pagedLogs: ManagerLog[];
  showMdPreview: boolean;
  expandedSections: Record<string, Set<string>>;
  logPage: number;
  totalLogPages: number;
  hasMoreLogs: boolean;
  sectionHtml: (md: string, preview: boolean) => string;
  managerPrompt: (promptText: string | undefined | null) => any;
  actionBadgeClass: (action: string) => any;
}>();

defineEmits<{
  (e: 'update:showMdPreview', value: boolean): void;
  (e: 'toggleSection', logId: string, section: string): void;
  (e: 'changePage', page: number): void;
  (e: 'loadMore'): void;
}>();
</script>

<template>
  <div class="logs-section">
    <div class="col-header">
      <span>Decision Log</span>
      <button
        class="btn btn-ghost btn-sm md-toggle"
        @click="$emit('update:showMdPreview', !showMdPreview)"
      >
        {{ showMdPreview ? 'MD ●' : 'MD ○' }}
      </button>
    </div>

    <div v-if="logs.length === 0" class="empty-state">
      <div class="empty-title">No decisions logged yet</div>
      <p>Start the manager to begin generating decisions.</p>
    </div>

    <div v-else class="manager-log-feed">
      <div v-for="log in pagedLogs" :key="log.id" class="dec-entry">
        <div class="dec-main">
          <div class="dec-main-header">
            <span class="badge" :class="actionBadgeClass(log.action)" style="font-size: 11px;">{{ log.action }}</span>
            <span class="dec-meta">{{ new Date(log.createdAt).toLocaleString() }}</span>
            <span
              v-if="log.llmPromptTokens != null || log.llmCompletionTokens != null"
              class="dec-meta mono tokens-meta"
            >
              {{ log.llmPromptTokens ?? '—' }}↑ {{ log.llmCompletionTokens ?? '—' }}↓
            </span>
          </div>
          <!-- eslint-disable-next-line vue/no-v-html -->
          <div class="chat-reasoning" :class="{ 'chat-reasoning--md': showMdPreview }" v-html="sectionHtml(log.reasoning, showMdPreview)" />
          <p v-if="log.result?.detail" class="dec-meta">{{ log.result.detail }}</p>
          <p v-if="log.result?.error" class="dec-meta error-text">{{ log.result.error }}</p>
        </div>

        <button class="dec-details-btn" @click="$emit('toggleSection', log.id, 'details')">
          Details {{ expandedSections[log.id]?.has('details') ? '▾' : '▸' }}
        </button>

        <div v-if="expandedSections[log.id]?.has('details')" class="dec-details">
          <div class="prompt-pills">
            <ManagerPromptSection
              title="SYSTEM"
              :content="managerPrompt(log.result?.llmPromptText).system"
              :is-open="expandedSections[log.id]?.has('system')"
              variant="system"
              :show-md-preview="showMdPreview"
              @toggle="$emit('toggleSection', log.id, 'system')"
            />

            <ManagerPromptSection
              title="PORTFOLIO CONTEXT"
              :content="managerPrompt(log.result?.llmPromptText).context"
              :is-open="expandedSections[log.id]?.has('context')"
              variant="market"
              :show-md-preview="showMdPreview"
              @toggle="$emit('toggleSection', log.id, 'context')"
            />

            <ManagerPromptSection
              title="EDITABLE SETUP"
              :content="managerPrompt(log.result?.llmPromptText).editableSetup"
              :is-open="expandedSections[log.id]?.has('setup')"
              variant="setup"
              :show-md-preview="showMdPreview"
              @toggle="$emit('toggleSection', log.id, 'setup')"
            />

            <ManagerPromptSection
              title="RESPONSE"
              :content="log.result?.llmRawResponse || '(no raw response stored)'"
              :is-open="expandedSections[log.id]?.has('response')"
              variant="llm"
              :show-md-preview="showMdPreview"
              @toggle="$emit('toggleSection', log.id, 'response')"
            />
          </div>
        </div>
      </div>

      <!-- Pagination -->
      <div v-if="totalLogPages > 1" class="log-pagination">
        <button class="btn btn-ghost btn-sm" :disabled="logPage === 1" @click="$emit('changePage', logPage - 1)">←</button>
        <span class="page-info">{{ logPage }} / {{ totalLogPages }}</span>
        <button class="btn btn-ghost btn-sm" :disabled="logPage >= totalLogPages && !hasMoreLogs" @click="$emit('changePage', logPage + 1)">→</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.col-header {
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-muted);
  margin-bottom: 12px;
  display: flex;
  align-items: center;
  gap: 8px;
}

.md-toggle { margin-left: auto; font-size: 11px; }

.empty-state { padding: 32px 24px; text-align: center; }

.manager-log-feed { display: flex; flex-direction: column; gap: 10px; }

.dec-entry {
  display: flex;
  flex-direction: column;
  padding: 10px 12px;
  background: var(--surface, #141414);
  border: 1px solid var(--border, #2a2a2a);
}

.dec-main { display: flex; flex-direction: column; gap: 8px; }

.dec-main-header { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }

.dec-meta {
  font-size: 11px;
  font-family: var(--font-mono, monospace);
  color: var(--text-muted);
}

.tokens-meta { margin-left: auto; white-space: nowrap; }
.error-text { color: var(--red); }

.dec-details-btn {
  background: transparent;
  border: none;
  padding: 0;
  margin-top: 6px;
  font-size: 11px;
  font-family: var(--font-mono, monospace);
  color: var(--text-muted);
  cursor: pointer;
  text-align: left;
}
.dec-details-btn:hover { color: var(--text); }

.dec-details {
  margin-top: 8px;
  border-top: 1px solid var(--border);
  padding-top: 8px;
}

.prompt-pills { display: flex; flex-direction: column; gap: 4px; }

.prompt-pill {
  display: flex;
  justify-content: flex-start;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  font-size: 11px;
  font-family: var(--font-mono, monospace);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  background: transparent;
  border: none;
  cursor: pointer;
  text-align: left;
  width: 100%;
  color: var(--text-muted);
}

.prompt-pill--market { color: #f59e0b; }
.prompt-pill--setup { color: #60a5fa; }
.prompt-pill--llm { color: #4ade80; }

.pill-chevron { flex-shrink: 0; font-size: 12px; }
.pill-content { padding-left: 10px; }

.dec-code-block {
  font-family: 'JetBrains Mono', monospace;
  font-size: 11px;
  line-height: 1.6;
  color: var(--text-secondary, #aaa);
  padding: 8px 10px;
  margin: 0;
  background: color-mix(in srgb, var(--border, #2a2a2a) 10%, transparent);
  border-radius: 4px;
  white-space: pre-wrap;
  word-break: break-word;
}

.chat-reasoning { font-size: 14px; line-height: 1.6; color: var(--text); }
.chat-reasoning :deep(p) { margin: 0 0 6px; }
.chat-reasoning :deep(ul) { margin: 4px 0; padding-left: 16px; }

.log-pagination {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  margin-top: 4px;
}
.page-info { font-size: 12px; color: var(--text-muted); }
</style>
