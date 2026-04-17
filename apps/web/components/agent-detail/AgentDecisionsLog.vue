<script setup lang="ts">
import { computed, ref, type PropType } from 'vue';
import { splitAgentPromptSections } from '~/lib/agent-prompt';
import { sectionHtml } from '~/utils/markdown';
import { formatRelativeTime } from '~/utils/formatting';

type AgentDecision = {
  id: string;
  decision: string;
  confidence: number;
  reasoning: string;
  llmModel: string;
  llmPromptText?: string;
  llmRawResponse?: string;
  llmPromptTokens?: number;
  llmCompletionTokens?: number;
  createdAt: string;
};

type PendingModification = {
  id: string;
  reason: string;
  changes: unknown;
};

const props = defineProps({
  agentId: {
    type: String,
    required: true,
  },
  decisions: {
    type: Array as PropType<AgentDecision[]>,
    required: true,
  },
  now: {
    type: Number,
    required: true,
  },
  modDecisionIds: {
    type: Object as PropType<Set<string>>,
    required: true,
  },
  pendingModifications: {
    type: Array as PropType<PendingModification[]>,
    required: true,
  },
  approveModification: {
    type: Function as PropType<(agentId: string, modificationId: string) => Promise<unknown>>,
    required: true,
  },
  rejectModification: {
    type: Function as PropType<(agentId: string, modificationId: string) => Promise<unknown>>,
    required: true,
  },
  isModelUnavailableError: {
    type: Boolean,
    default: false,
  },
});

const showMdPreview = ref(false);
const expandedSections = ref<Record<string, Set<string>>>({});

const normalizedDecisions = computed(() =>
  props.decisions.map((decision) => ({
    ...decision,
    promptSections: decision.llmPromptText ? splitAgentPromptSections(decision.llmPromptText) : null,
  })),
);

function formatJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

function decisionHtml(text: string, md: boolean): string {
  let cleanText = text;
  const execIdx = cleanText.indexOf('\n\n—\nExecution:');
  if (execIdx !== -1) {
    cleanText = cleanText.substring(0, execIdx);
  }
  return sectionHtml(cleanText, md);
}

function hasEditedSetup(decisionId: string, index: number): boolean {
  const current = normalizedDecisions.value[index];
  const previous = normalizedDecisions.value[index + 1];
  if (!current?.promptSections?.editableSetup || !previous?.promptSections?.editableSetup) return false;
  return current.promptSections.editableSetup !== previous.promptSections.editableSetup;
}

function toggleSection(decisionId: string, section: string) {
  const current = expandedSections.value[decisionId] ?? new Set<string>();
  const next = new Set(current);
  if (next.has(section)) {
    next.delete(section);
  } else {
    next.add(section);
  }
  expandedSections.value = { ...expandedSections.value, [decisionId]: next };
}

function isExpanded(decisionId: string, section: string) {
  return expandedSections.value[decisionId]?.has(section) ?? false;
}

function mapDecision(decision: string) {
  const norm = decision.toUpperCase();
  if (norm === 'OPEN_LONG') return 'buy';
  if (norm === 'OPEN_SHORT') return 'sell';
  if (norm === 'CLOSE_LONG' || norm === 'CLOSE_SHORT') return 'close';
  return decision.toLowerCase();
}

function timeAgo(iso: string) {
  return formatRelativeTime(iso, props.now);
}
</script>

<template>
  <div>
    <div v-if="pendingModifications.length > 0" class="dec-section pending-mods">
      <div class="dec-section-header">
        <span class="dec-section-title">Pending Self-Modifications</span>
        <span class="dec-section-count">{{ pendingModifications.length }}</span>
      </div>
      <div class="self-mod-list">
        <div v-for="mod in pendingModifications" :key="mod.id" class="self-mod-item">
          <div class="self-mod-reason">{{ mod.reason }}</div>
          <pre class="self-mod-changes">{{ JSON.stringify(mod.changes, null, 2) }}</pre>
          <div class="self-mod-actions">
            <button class="btn btn-success btn-sm" @click="approveModification(agentId, mod.id)">✓ Apply</button>
            <button class="btn btn-ghost btn-sm" @click="rejectModification(agentId, mod.id)">✕ Reject</button>
          </div>
        </div>
      </div>
    </div>

    <div class="dec-section">
      <div class="dec-section-header">
        <span class="dec-section-title">Decisions Log</span>
        <span class="dec-section-count">{{ decisions.length }}</span>
        <button class="btn btn-ghost btn-sm md-toggle" @click="showMdPreview = !showMdPreview">
          {{ showMdPreview ? 'MD ●' : 'MD ○' }}
        </button>
      </div>

      <div v-if="decisions.length === 0" class="dec-empty">
        No decisions yet — click <strong>⚡ Run Analysis</strong> to fetch market data and get the LLM&apos;s reasoning
      </div>

      <div v-else class="chat-feed">
        <div v-for="(dec, idx) in normalizedDecisions" :key="dec.id" class="dec-entry">
          <div class="dec-main">
            <div class="dec-main-header">
              <span class="dec-action-badge" :class="`dec-action--${mapDecision(dec.decision)}`">{{ mapDecision(dec.decision).toUpperCase() }}</span>
              <span class="dec-conf-num">
                <span class="dec-conf-tooltip-anchor">
                  <span class="dec-conf-label">Conf.</span>
                  <span class="dec-conf-tooltip">Confidence is the model's self-reported conviction in this decision, from 0% to 100%.</span>
                </span>
                {{ (dec.confidence * 100).toFixed(0) }}%
              </span>
              <div class="dec-conf-track">
                <div class="dec-conf-fill" :class="`dec-conf-fill--${mapDecision(dec.decision)}`" :style="{ width: `${dec.confidence * 100}%` }" />
              </div>
            </div>
            <!-- eslint-disable-next-line vue/no-v-html -->
            <div class="chat-reasoning" :class="showMdPreview ? ['chat-reasoning--md', 'md-content'] : []" v-html="decisionHtml(dec.reasoning, showMdPreview)" />
            <div class="dec-meta">
              {{ dec.llmModel.split('/').pop() }} · {{ timeAgo(dec.createdAt) }}
              <span v-if="modDecisionIds.has(dec.id)" class="badge-self-mod">✎ self-modified</span>
            </div>
          </div>

          <button v-if="dec.llmPromptText || dec.llmRawResponse" class="dec-details-btn" @click="toggleSection(dec.id, 'details')">
            Details {{ isExpanded(dec.id, 'details') ? '▾' : '▸' }}
          </button>

          <div v-if="isExpanded(dec.id, 'details')" class="dec-details">
            <template v-if="dec.promptSections">
              <div class="dec-details-section-label">
                PROMPT →
                <span v-if="hasEditedSetup(dec.id, idx)" class="pill-edited-tag">setup edited</span>
              </div>
              <div class="prompt-pills">
                <button class="prompt-pill prompt-pill--system" @click="toggleSection(dec.id, 'system')">
                  <span>[SYSTEM]</span>
                  <span class="pill-chevron">{{ isExpanded(dec.id, 'system') ? '▾' : '▸' }}</span>
                </button>
                <div v-if="isExpanded(dec.id, 'system')" class="pill-content">
                  <pre v-if="!showMdPreview" class="dec-code-block">{{ dec.promptSections.system }}</pre>
                  <!-- eslint-disable-next-line vue/no-v-html -->
                  <div
                    v-else
                    class="dec-code-block chat-reasoning chat-reasoning--md md-content"
                    v-html="decisionHtml(dec.promptSections.system, true)"
                  />
                </div>

                <button class="prompt-pill prompt-pill--market" @click="toggleSection(dec.id, 'market')">
                  <span>[MARKET DATA]</span>
                  <span class="pill-chevron">{{ isExpanded(dec.id, 'market') ? '▾' : '▸' }}</span>
                </button>
                <div v-if="isExpanded(dec.id, 'market')" class="pill-content">
                  <pre v-if="!showMdPreview" class="dec-code-block">{{ dec.promptSections.marketData }}</pre>
                  <!-- eslint-disable-next-line vue/no-v-html -->
                  <div
                    v-else
                    class="dec-code-block chat-reasoning chat-reasoning--md md-content"
                    v-html="decisionHtml(dec.promptSections.marketData, true)"
                  />
                </div>

                <button class="prompt-pill prompt-pill--setup" @click="toggleSection(dec.id, 'setup')">
                  <span>[EDITABLE SETUP]</span>
                  <span class="pill-chevron">{{ isExpanded(dec.id, 'setup') ? '▾' : '▸' }}</span>
                </button>
                <div v-if="isExpanded(dec.id, 'setup')" class="pill-content">
                  <pre v-if="!showMdPreview" class="dec-code-block">{{ dec.promptSections.editableSetup }}</pre>
                  <!-- eslint-disable-next-line vue/no-v-html -->
                  <div
                    v-else
                    class="dec-code-block chat-reasoning chat-reasoning--md md-content"
                    v-html="decisionHtml(dec.promptSections.editableSetup, true)"
                  />
                </div>
              </div>
            </template>

            <template v-if="dec.llmRawResponse">
              <div class="dec-details-section-label dec-details-section-label--llm">
                ← LLM
                <span class="dec-details-tokens">{{ (dec.llmPromptTokens ?? 0).toLocaleString() }}↑ {{ (dec.llmCompletionTokens ?? 0).toLocaleString() }}↓</span>
              </div>
              <button class="prompt-pill prompt-pill--llm-response" @click="toggleSection(dec.id, 'response')">
                <span>[RESPONSE]</span>
                <span class="pill-chevron">{{ isExpanded(dec.id, 'response') ? '▾' : '▸' }}</span>
              </button>
              <div v-if="isExpanded(dec.id, 'response')" class="pill-content">
                <pre v-if="!showMdPreview" class="dec-code-block">{{ formatJson(dec.llmRawResponse) }}</pre>
                <!-- eslint-disable-next-line vue/no-v-html -->
                <div
                  v-else
                  class="dec-code-block chat-reasoning chat-reasoning--md md-content"
                  v-html="decisionHtml(dec.llmRawResponse, true)"
                />
              </div>
            </template>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.pending-mods {
  margin-bottom: 16px;
}

.md-toggle {
  margin-left: auto;
  font-size: 11px;
}

.chat-feed {
  display: flex;
  flex-direction: column;
  gap: 0;
}

.dec-entry {
  display: flex;
  flex-direction: column;
  gap: 0;
  padding-left: 12px;
  margin-bottom: 16px;
  background: #1b1c1c;
  min-height: fit-content;
}

.dec-main {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 0;
}

.dec-main-header {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.dec-conf-num {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}

.dec-entry:has(.dec-conf-tooltip-anchor:hover) {
  position: relative;
  z-index: 50;
}

.dec-conf-tooltip-anchor {
  position: relative;
  display: inline-flex;
  align-items: center;
  cursor: help;
}

.dec-conf-label {
  color: var(--text-muted);
  text-decoration: underline;
  text-decoration-style: dashed;
  text-underline-offset: 2px;
}

.dec-conf-tooltip {
  display: none;
  position: absolute;
  bottom: calc(100% + 6px);
  left: -2rem;
  white-space: nowrap;
  background: #1e1e1e;
  border: 1px solid var(--border, #2a2a2a);
  border-radius: 4px;
  padding: 5px 9px;
  font-size: 11px;
  font-family: var(--font-mono, monospace);
  color: var(--text, #e0e0e0);
  pointer-events: none;
  z-index: 19999;
}

.dec-conf-tooltip-anchor:hover .dec-conf-tooltip {
  display: block;
}

.dec-meta {
  font-size: 11px;
  font-family: var(--font-mono, monospace);
  color: var(--text-muted);
}

.dec-details-btn {
  display: block;
  background: transparent;
  border: none;
  padding: 0;
  font-size: 11px;
  font-family: var(--font-mono, monospace);
  color: var(--text-muted);
  cursor: pointer;
  text-align: left;
  letter-spacing: 0.04em;
  margin-bottom: 10px;
}

.dec-details-btn:hover {
  color: var(--text);
}

.dec-details {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px 0 4px;
  border-top: 1px solid var(--border);
  margin-top: 2px;
}

.dec-details-section-label {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 10px;
  font-family: var(--font-mono, monospace);
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--text-muted);
  margin-top: 8px;
  margin-bottom: 2px;
}

.dec-details-section-label:first-child {
  margin-top: 0;
}

.dec-details-section-label--llm {
  color: #4ade80;
  border-top: 1px solid var(--border);
  padding-top: 8px;
}

.dec-details-tokens {
  font-size: 10px;
  font-family: var(--font-mono, monospace);
  color: var(--text-muted);
  text-transform: none;
  letter-spacing: 0;
}

.prompt-pills {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

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
  transition: opacity 0.1s;
}

.prompt-pill:hover {
  opacity: 0.75;
}

.prompt-pill--system { color: var(--text-muted); }
.prompt-pill--market { color: #f59e0b; }
.prompt-pill--setup { color: #60a5fa; }
.prompt-pill--llm-response { color: #4ade80; }

.pill-chevron {
  flex-shrink: 0;
  font-size: 12px;
}

.pill-edited-tag {
  font-size: 10px;
  color: #f59e0b;
  border: 1px solid #f59e0b;
  padding: 0 4px;
  margin-left: 4px;
  flex-shrink: 0;
}

.pill-content {
  padding-left: 10px;
}

.chat-reasoning {
  font-size: 14px;
  line-height: 1.6;
  color: var(--text);
}

.badge-self-mod {
  display: inline-flex;
  align-items: center;
  font-size: 10px;
  font-weight: 600;
  color: #a78bfa;
  background: color-mix(in srgb, #a78bfa 12%, transparent);
  border: 1px solid color-mix(in srgb, #a78bfa 30%, transparent);
  border-radius: 4px;
  padding: 1px 5px;
  margin-left: 6px;
}

.self-mod-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.self-mod-item {
  background: var(--surface, #141414);
  border: 1px solid color-mix(in srgb, #a78bfa 25%, transparent);
  border-radius: 8px;
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.self-mod-reason {
  font-size: 13px;
  color: var(--text, #e0e0e0);
  line-height: 1.5;
}

.self-mod-changes {
  font-family: var(--font-mono, monospace);
  font-size: 11px;
  color: var(--text-secondary, #aaa);
  background: color-mix(in srgb, var(--border, #2a2a2a) 15%, transparent);
  border-radius: 4px;
  padding: 8px 10px;
  white-space: pre-wrap;
  word-break: break-word;
  margin: 0;
  max-height: 180px;
  overflow-y: auto;
}

.self-mod-actions {
  display: flex;
  gap: 8px;
}
</style>
