<script setup lang="ts">
import { useRoute } from 'vue-router';
import { watch } from 'vue';
import { useAgentDetailPage } from '~/features/agents/detail/useAgentDetailPage';

import AgentHeaderSection from '~/components/agent-detail/AgentHeaderSection.vue';
import AgentStatsSection from '~/components/agent-detail/AgentStatsSection.vue';
import AgentLiveStatusSection from '~/components/agent-detail/AgentLiveStatusSection.vue';
import AgentDecisionsLog from '~/components/agent-detail/AgentDecisionsLog.vue';
import AgentPositionsSection from '~/components/agent-detail/AgentPositionsSection.vue';

const route = useRoute();
const id = route.params.id as string;
const justCreated = route.query.justCreated === '1';

const {
  agent,
  trades,
  decisions,
  snapshots,
  doStatus,
  loading,
  loadError,
  isAnalyzing,
  analyzeStatusText,
  analyzeError,
  livePrices,
  livePricesLoading,
  livePricesError,
  menuOpen,
  now,
  clearingHistory,
  isModelUnavailableError,
  openTrades,
  closedTrades,
  winRate,
  realizedPnlUsd,
  unrealizedPnlUsd,
  totalPnlUsd,
  totalPnlPct,
  inPositionsUsd,
  displayedBalance,
  totalTokensUsed,
  totalPromptTokens,
  totalCompletionTokens,
  secondsUntilNextAction,
  isNextAnalysisImminent,
  pendingModifications,
  modDecisionIds,
  loadAll,
  handleStart,
  handleStop,
  handleAnalyze,
  handleDeleteAgent,
  handleClearHistory,
  handleToggleAutoSign,
  closeTradeByUser,
  approve,
  reject,
  pnlClass,
} = useAgentDetailPage(id);

definePageMeta({ ssr: false });

if (justCreated) {
  const stopWatch = watch(loading, (isLoading) => {
    if (!isLoading && agent.value) {
      stopWatch();
      handleAnalyze();
    }
  });
}
</script>

<template>
  <main class="page">
    <div v-if="loading && !agent" class="page-loader">
      <div class="page-loader-track">
        <span class="page-loader-block" /><span class="page-loader-block" /><span class="page-loader-block" /><span class="page-loader-block" />
        <span class="page-loader-block" /><span class="page-loader-block" /><span class="page-loader-block" /><span class="page-loader-block" />
      </div>
      <span class="page-loader-label">Loading agent</span>
    </div>

    <div v-else-if="loadError" style="text-align: center; padding: 64px;">
      <div class="api-error-banner" style="display: inline-flex; max-width: 500px;">
        <span class="error-icon">!</span>
        <span>{{ loadError }}</span>
        <button class="btn btn-ghost btn-sm" @click="loadAll">Retry</button>
      </div>
    </div>

    <template v-else-if="agent">
      <AgentHeaderSection
        v-model:menu-open="menuOpen"
        :agent="agent"
        :is-analyzing="isAnalyzing"
        :analyze-status-text="analyzeStatusText"
        :clearing-history="clearingHistory"
        :live-prices-loading="livePricesLoading"
        :live-prices-error="livePricesError"
        @analyze="handleAnalyze"
        @start="handleStart"
        @stop="handleStop"
        @clear-history="handleClearHistory"
        @delete="handleDeleteAgent"
      />

      <div v-if="analyzeError" class="api-error-banner" style="margin-bottom: 16px; align-items: flex-start;">
        <span class="error-icon" style="margin-top: 1px;">!</span>
        <div style="flex: 1; min-width: 0;">
          <template v-if="isModelUnavailableError">
            This model is currently unavailable. Choose another model in agent settings, or enable "Try fallback model" if you've set one.
          </template>
          <template v-else>{{ analyzeError }}</template>
        </div>
        <div style="display: flex; align-items: center; gap: 8px; flex-shrink: 0;">
          <NuxtLink
            v-if="isModelUnavailableError"
            :to="`/agents/${id}/edit`"
            class="btn btn-ghost btn-sm"
          >
            Select other model
          </NuxtLink>
          <button class="btn btn-ghost btn-sm" @click="analyzeError = null" aria-label="Dismiss">✕</button>
        </div>
      </div>

      <AgentStatsSection
        :agent="agent"
        :displayed-balance="displayedBalance"
        :realized-pnl-usd="realizedPnlUsd"
        :total-pnl-pct="totalPnlPct"
        :unrealized-pnl-usd="unrealizedPnlUsd"
        :win-rate="winRate"
        :closed-trades-count="closedTrades.length"
        :is-analyzing="isAnalyzing"
        :is-next-analysis-imminent="isNextAnalysisImminent"
        :seconds-until-next-action="secondsUntilNextAction"
        :open-trades-count="openTrades.length"
        :in-positions-usd="inPositionsUsd"
      />

      <AgentLiveStatusSection
        :total-tokens-used="totalTokensUsed"
        :total-prompt-tokens="totalPromptTokens"
        :total-completion-tokens="totalCompletionTokens"
      />

      <AgentDecisionsLog
        :agent-id="id"
        :decisions="decisions"
        :mod-decision-ids="modDecisionIds"
        :now="now"
        :pending-modifications="pendingModifications"
        :approve-modification="approve"
        :reject-modification="reject"
      />

      <AgentPositionsSection
        :agent="agent"
        :closing-trades="new Set()"
        :close-trade-by-user="closeTradeByUser"
        :decisions="decisions"
        :is-analyzing="isAnalyzing"
        :is-next-analysis-imminent="isNextAnalysisImminent"
        :live-prices="livePrices"
        :now="now"
        :pnl-class="pnlClass"
        :seconds-until-next-action="secondsUntilNextAction"
        :trades="trades"
      />
    </template>
  </main>
</template>

<style scoped>
/* Page-level styles kept in index for layout-specific overrides if needed */
</style>
