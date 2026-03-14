<script setup lang="ts">
definePageMeta({ ssr: false });
const route = useRoute();
const router = useRouter();
const id = computed(() => route.params.id as string);
const { getAgent, updateAgent } = useAgents();
const { request } = useApi();

const agent = ref<any>(null);
const loading = ref(true);
const saving = ref(false);
const error = ref('');

// Prompt preview state
const previewLoading = ref(true);
const previewError = ref('');
const systemPrompt = ref('');
const userPrompt = ref('');
const marketDataAt = ref<string | null>(null);
const hasMarketData = ref(false);

// Expandable sections in preview
const systemExpanded = ref(false);
const marketDataExpanded = ref(false);

onMounted(async () => {
  try {
    agent.value = await getAgent(id.value);
  } finally {
    loading.value = false;
  }

  // Fetch prompt preview once on open
  try {
    const data = await request<{
      systemPrompt: string;
      userPrompt: string;
      marketDataAt: string | null;
      hasMarketData: boolean;
    }>(`/agents/${id.value}/prompt-preview`);
    systemPrompt.value = data.systemPrompt;
    userPrompt.value = data.userPrompt;
    marketDataAt.value = data.marketDataAt;
    hasMarketData.value = data.hasMarketData;
  } catch {
    previewError.value = 'Failed to load prompt preview';
  } finally {
    previewLoading.value = false;
  }
});

async function handleSave(payload: any) {
  error.value = '';
  saving.value = true;
  try {
    await updateAgent(id.value, payload);
    router.push(`/agents/${id.value}`);
  } catch (e: any) {
    error.value = e.message ?? 'Save failed';
  } finally {
    saving.value = false;
  }
}

function handleCancel() {
  router.push(`/agents/${id.value}`);
}

// Extract Market Data section from userPrompt for collapsible display
const marketDataContent = computed(() => {
  if (!userPrompt.value) return '';
  const match = userPrompt.value.match(/## Market Data[\s\S]*?(?=\n## (?!###)|$)/);
  return match ? match[0].trim() : '';
});

const promptWithoutMarketData = computed(() => {
  if (!userPrompt.value) return '';
  if (!marketDataContent.value) return userPrompt.value;
  return userPrompt.value.replace(marketDataContent.value, '').trim();
});

function formatTime(iso: string | null) {
  if (!iso) return '';
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
</script>

<template>
  <div class="edit-page">
    <div v-if="loading" class="edit-page__loading">Loading…</div>
    <template v-else>
      <!-- Sticky command bar -->
      <div class="edit-bar">
        <NuxtLink :to="`/agents/${id}`" class="edit-bar__back">← back</NuxtLink>
        <span class="edit-bar__sep">/</span>
        <span class="edit-bar__name">{{ agent?.name ?? 'Edit Agent' }}</span>
        <div class="edit-bar__actions">
          <button type="button" class="edit-bar__cancel" @click="handleCancel">Cancel</button>
          <button
            type="submit"
            form="agent-config-form"
            class="edit-bar__save"
            :disabled="saving"
          >
            <span v-if="saving" class="spinner" style="width:13px;height:13px;border-color:#fff3;border-top-color:#fff" />
            {{ saving ? 'Saving…' : 'Save Changes' }}
          </button>
        </div>
      </div>

      <div v-if="error" class="edit-error">{{ error }}</div>

      <div class="edit-page__body">
        <!-- Left: Config form -->
        <div class="edit-page__left">
          <AgentConfigForm
            v-if="agent"
            :initial-values="{ ...agent.config, ...agent, pairs: agent.config?.pairs }"
            @submit="handleSave"
            @cancel="handleCancel"
          />
        </div>

        <!-- Right: Prompt preview -->
        <div class="edit-page__right">
          <div class="prompt-preview">
            <div class="prompt-preview__header">
              <span class="prompt-preview__title">PROMPT PREVIEW</span>
              <span v-if="marketDataAt" class="prompt-preview__meta">
                market data · {{ formatTime(marketDataAt) }}
              </span>
              <span v-else class="prompt-preview__meta">no market snapshot yet</span>
            </div>

            <div v-if="previewLoading" class="prompt-preview__state">fetching prompt…</div>
            <div v-else-if="previewError" class="prompt-preview__state prompt-preview__state--error">{{ previewError }}</div>
            <template v-else>
              <!-- SYSTEM — collapsed by default -->
              <div class="prompt-section">
                <button class="prompt-section__toggle" type="button" @click="systemExpanded = !systemExpanded">
                  <span class="prompt-section__label">SYSTEM</span>
                  <span class="prompt-section__chevron" :class="{ open: systemExpanded }">›</span>
                </button>
                <pre v-if="systemExpanded" class="prompt-section__content">{{ systemPrompt }}</pre>
              </div>

              <!-- MARKET DATA — collapsed by default -->
              <div class="prompt-section">
                <button class="prompt-section__toggle" type="button" @click="marketDataExpanded = !marketDataExpanded">
                  <span class="prompt-section__label">MARKET DATA</span>
                  <span v-if="!hasMarketData" class="prompt-section__hint">no data yet</span>
                  <span class="prompt-section__chevron" :class="{ open: marketDataExpanded }">›</span>
                </button>
                <pre v-if="marketDataExpanded" class="prompt-section__content">{{ marketDataContent || '(no market data yet — run agent first)' }}</pre>
              </div>

              <!-- Rest of prompt — always visible -->
              <pre v-if="promptWithoutMarketData" class="prompt-section__content prompt-section__content--main">{{ promptWithoutMarketData }}</pre>
            </template>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.edit-page {
  min-height: 100vh;
  background: var(--bg, #0a0a0a);
  padding: 0 24px 40px;
  display: flex;
  flex-direction: column;
  gap: 20px;
  max-width: 1600px;
  margin: 0 auto;
}
.edit-page__loading {
  color: var(--text-muted, #555);
  padding: 40px;
  text-align: center;
  font-family: 'JetBrains Mono', monospace;
  font-size: 12px;
}

/* ── Command bar ────────────────────────────────────────────────── */
.edit-bar {
  position: sticky;
  top: 0;
  z-index: 20;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 0;
  background: var(--bg, #0a0a0a);
  border-bottom: 1px solid var(--border, #1e1e1e);
}
.edit-bar__back {
  font-family: 'JetBrains Mono', monospace;
  font-size: 11px;
  color: var(--text-muted, #555);
  text-decoration: none;
  white-space: nowrap;
  transition: color 0.15s;
}
.edit-bar__back:hover { color: var(--text, #e0e0e0); }
.edit-bar__sep {
  color: var(--border, #333);
  font-size: 14px;
  font-weight: 300;
}
.edit-bar__name {
  flex: 1;
  font-size: 13px;
  font-weight: 600;
  color: var(--text, #e0e0e0);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.edit-bar__actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}
.edit-bar__cancel {
  padding: 7px 14px;
  background: none;
  border: 1px solid var(--border, #2a2a2a);
  border-radius: 5px;
  color: var(--text-muted, #666);
  font-size: 12px;
  cursor: pointer;
  transition: border-color 0.15s, color 0.15s;
}
.edit-bar__cancel:hover { border-color: var(--text-muted, #555); color: var(--text, #e0e0e0); }
.edit-bar__save {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 8px 20px;
  background: var(--accent, #7c6af7);
  color: #fff;
  border: none;
  border-radius: 5px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition: opacity 0.15s;
  letter-spacing: 0.01em;
}
.edit-bar__save:hover { opacity: 0.88; }
.edit-bar__save:disabled { opacity: 0.45; cursor: not-allowed; }

.edit-error {
  padding: 10px 14px;
  background: color-mix(in srgb, #e55 10%, transparent);
  border: 1px solid color-mix(in srgb, #e55 30%, transparent);
  border-radius: 6px;
  font-size: 13px;
  color: #e55;
}

/* ── Two-column body ────────────────────────────────────────────── */
.edit-page__body {
  display: grid;
  grid-template-columns: minmax(460px, 2fr) 3fr;
  gap: 28px;
  align-items: start;
}
.edit-page__left {
  position: sticky;
  top: 53px; /* matches command bar height */
  max-height: calc(100vh - 73px);
  overflow-y: auto;
  scrollbar-width: thin;
  scrollbar-color: var(--border, #2a2a2a) transparent;
}
.edit-page__right { min-width: 0; }

/* ── Prompt preview panel ───────────────────────────────────────── */
.prompt-preview {
  background: var(--surface, #111);
  border: 1px solid var(--border, #222);
  border-left: 3px solid color-mix(in srgb, var(--accent, #7c6af7) 40%, transparent);
  overflow: hidden;
  display: flex;
  flex-direction: column;
}
.prompt-preview__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  border-bottom: 1px solid var(--border, #1e1e1e);
  background: color-mix(in srgb, var(--border, #2a2a2a) 20%, transparent);
  gap: 12px;
}
.prompt-preview__title {
  font-family: 'JetBrains Mono', monospace;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.12em;
  color: color-mix(in srgb, var(--accent, #7c6af7) 70%, var(--text-muted, #555));
}
.prompt-preview__meta {
  font-family: 'JetBrains Mono', monospace;
  font-size: 10px;
  color: var(--text-muted, #3a3a3a);
  margin-left: auto;
}
.prompt-preview__state {
  padding: 20px 14px;
  font-family: 'JetBrains Mono', monospace;
  font-size: 11px;
  color: var(--text-muted, #444);
}
.prompt-preview__state--error { color: #e55; }

/* Section rows */
.prompt-section {
  border-bottom: 1px solid var(--border, #1a1a1a);
}
.prompt-section:last-child { border-bottom: none; }
.prompt-section__toggle {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 9px 14px;
  background: none;
  border: none;
  color: var(--text-muted, #444);
  font-family: 'JetBrains Mono', monospace;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  cursor: pointer;
  text-align: left;
  gap: 8px;
  transition: background 0.12s;
}
.prompt-section__toggle:hover {
  background: color-mix(in srgb, var(--border, #2a2a2a) 25%, transparent);
  color: var(--text-muted, #666);
}
.prompt-section__label { flex: 1; }
.prompt-section__hint {
  font-size: 9px;
  font-weight: 400;
  text-transform: none;
  letter-spacing: 0;
  color: var(--text-muted, #333);
}
.prompt-section__chevron {
  font-size: 14px;
  transition: transform 0.18s;
  display: inline-block;
  opacity: 0.5;
}
.prompt-section__chevron.open { transform: rotate(90deg); opacity: 1; }

.prompt-section__content {
  font-family: 'JetBrains Mono', 'Fira Code', monospace;
  font-size: 11px;
  line-height: 1.7;
  color: var(--text-secondary, #888);
  padding: 12px 14px;
  white-space: pre-wrap;
  word-break: break-word;
  margin: 0;
  border-top: 1px solid var(--border, #1a1a1a);
}
.prompt-section__content--main {
  max-height: 70vh;
  overflow-y: auto;
  color: var(--text-secondary, #999);
  scrollbar-width: thin;
  scrollbar-color: var(--border, #2a2a2a) transparent;
}

@media (max-width: 1000px) {
  .edit-page__body {
    grid-template-columns: 1fr;
  }
  .edit-page__left {
    position: static;
    max-height: none;
  }
}
</style>
