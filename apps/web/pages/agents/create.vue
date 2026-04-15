<script setup lang="ts">
definePageMeta({ ssr: false });

import AgentConfigForm from '~/components/AgentConfigForm.vue';
import AgentCreateFundingStep from '~/components/AgentCreateFundingStep.vue';
import AgentPromptPreviewPanel from '~/components/AgentPromptPreviewPanel.vue';
import { useAgentCreateFlow } from '~/features/agents/create/useAgentCreateFlow';

const configFormRef = ref<InstanceType<typeof AgentConfigForm> | null>(null);
const {
  step,
  isPaper,
  fundAmount,
  faucetAmount,
  createdAgentId,
  currentPaperBalance,
  creating,
  funding,
  withdrawing,
  bridging,
  mintingFaucet,
  onchainStatus,
  walletIusdDisplay,
  fundingBusy,
  consentModalOpen,
  goToStep,
  clearFundingFeedback,
  handleConsentProceed,
  handleConsentCancel,
  handleNext,
  handleDeposit,
  handleWithdraw,
  handleBridge,
  handleMintFaucet,
  handleCancel,
  handleOpenAgent,
} = useAgentCreateFlow();
</script>

<template>
  <div class="edit-page">
    <div class="edit-bar">
      <NuxtLink to="/agents" class="edit-bar__back">← Agents</NuxtLink>

      <nav class="edit-bar__steps">
        <button
          class="step-item"
          :class="{ 'step-item--active': step === 1, 'step-item--done': step > 1 }"
          @click="goToStep(1)"
        >
          <span class="step-item__num">1</span>
          <span class="step-item__label">Configure agent</span>
        </button>
        <template v-if="!isPaper">
          <span class="step-arrow">→</span>
          <button
            class="step-item"
            :class="{ 'step-item--active': step === 2, 'step-item--pending': !createdAgentId }"
            :disabled="!createdAgentId"
            @click="goToStep(2)"
          >
            <span class="step-item__num">2</span>
            <span class="step-item__label">Fund agent</span>
          </button>
        </template>
      </nav>

      <div class="edit-bar__actions">
        <template v-if="step === 1">
          <div class="mode-toggle">
            <button
              class="mode-toggle__btn"
              :class="{ 'mode-toggle__btn--active': !isPaper }"
              type="button"
              @click="isPaper = false"
            >Real</button>
            <button
              class="mode-toggle__btn"
              :class="{ 'mode-toggle__btn--active': isPaper, 'mode-toggle__btn--paper': isPaper }"
              type="button"
              @click="isPaper = true"
            >Paper</button>
          </div>
          <button type="button" class="edit-bar__cancel" @click="handleCancel">Cancel</button>
          <button type="submit" form="agent-config-form" class="edit-bar__save" :class="{ 'edit-bar__save--paper': isPaper }" :disabled="creating">
            <span v-if="creating" class="spinner" style="width:13px;height:13px;border-color:#fff3;border-top-color:#fff" />
            {{ creating ? 'Creating...' : (isPaper ? 'Create Paper Agent →' : (onchainStatus || 'Create Agent →')) }}
          </button>
        </template>
        <template v-else>
          <button type="button" class="edit-bar__save" :disabled="!createdAgentId" @click="handleOpenAgent">
            Open Agent
          </button>
        </template>
      </div>
    </div>

    <div v-if="isPaper && step === 1" class="paper-callout">
      <span>Paper Trading — simulated balance, no wallet or on-chain transaction needed. You can set your starting balance under Trading Config bellow.</span>
    </div>

    <div v-show="step === 1" class="edit-page__body">
      <div class="edit-page__left">
        <AgentConfigForm
          ref="configFormRef"
          hide-persona-editor
          :hide-balance-input="false"
          :hide-footer="true"
          @submit="handleNext"
          @cancel="handleCancel"
        />
      </div>

      <div class="edit-page__right">
        <AgentPromptPreviewPanel :form-ref="configFormRef" :initially-expanded="false" />
      </div>
    </div>

    <div v-if="step === 2 && !isPaper">
      <AgentCreateFundingStep
        v-model:fund-amount="fundAmount"
        v-model:faucet-amount="faucetAmount"
        :current-paper-balance="currentPaperBalance"
        :wallet-iusd-display="walletIusdDisplay"
        :busy="fundingBusy"
        :funding="funding"
        :withdrawing="withdrawing"
        :bridging="bridging"
        :minting-faucet="mintingFaucet"
        @deposit="handleDeposit"
        @withdraw="handleWithdraw"
        @bridge="handleBridge"
        @mint-faucet="handleMintFaucet"
        @clear-feedback="clearFundingFeedback"
      />
    </div>
  </div>

  <AutoSignConsentModal
    :open="consentModalOpen"
    @proceed="handleConsentProceed"
    @cancel="handleConsentCancel"
  />

  <Teleport to="body">
    <div v-if="creating" class="create-overlay">
      <div class="create-overlay__inner">
        <div class="page-loader-track">
          <span class="page-loader-block" /><span class="page-loader-block" /><span class="page-loader-block" /><span class="page-loader-block" />
          <span class="page-loader-block" /><span class="page-loader-block" /><span class="page-loader-block" /><span class="page-loader-block" />
        </div>
        <span class="create-overlay__label">Creating agent…</span>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.edit-page {
  min-height: 100vh;
  background: var(--bg, #0a0a0a);
  padding: 0 24px 40px;
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.edit-bar {
  position: sticky;
  top: 52px;
  z-index: 20;
  display: flex;
  align-items: center;
  padding: 10px 0;
  background: var(--bg, #0a0a0a);
  border-bottom: 1px solid var(--border, #1e1e1e);
}

.edit-bar__back {
  flex-shrink: 0;
  font-size: 12px;
  font-weight: 700;
  font-family: 'Space Mono', monospace;
  letter-spacing: 0.04em;
  color: var(--text-muted, #555);
  text-decoration: none;
  white-space: nowrap;
  transition: color 0.12s;
}

.edit-bar__back:hover { color: var(--accent, #7c6af7); }

.edit-bar__steps {
  position: absolute;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 10px;
  pointer-events: none;
}

.step-item {
  display: flex;
  align-items: center;
  gap: 7px;
  background: none;
  border: none;
  padding: 4px 8px;
  border-radius: 3px;
  cursor: pointer;
  pointer-events: auto;
  transition: opacity 0.12s;
  opacity: 0.35;
}

.step-item:disabled { cursor: default; }
.step-item:not(:disabled):hover { opacity: 0.65; }
.step-item--active { opacity: 1; }
.step-item--done { opacity: 0.55; }
.step-item--done:not(:disabled):hover { opacity: 0.8; }
.step-item--pending { opacity: 0.25; }

.step-item__num {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  border: 1px solid var(--border, #2a2a2a);
  font-family: 'Space Mono', monospace;
  font-size: 9px;
  font-weight: 700;
  color: var(--text-muted, #666);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  transition: border-color 0.12s, background 0.12s, color 0.12s;
}

.step-item--active .step-item__num {
  border-color: var(--accent, #7c6af7);
  background: color-mix(in srgb, var(--accent, #7c6af7) 15%, transparent);
  color: var(--accent, #7c6af7);
}

.step-item--done .step-item__num {
  border-color: #4ade80;
  background: color-mix(in srgb, #4ade80 10%, transparent);
  color: #4ade80;
}

.step-item__label {
  font-family: 'Space Mono', monospace;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: var(--text-muted, #666);
  white-space: nowrap;
  transition: color 0.12s;
}

.step-item--active .step-item__label { color: var(--text, #e0e0e0); }

.step-arrow {
  font-size: 11px;
  color: var(--border, #333);
  flex-shrink: 0;
}

.edit-bar__actions {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}

.edit-bar__cancel {
  padding: 6px 14px;
  background: none;
  border: 1px solid #2a2a2a;
  border-radius: 3px;
  color: #555;
  font-size: 11px;
  font-family: 'Space Mono', monospace;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  cursor: pointer;
  transition: border-color 0.12s, color 0.12s;
}

.edit-bar__cancel:hover { border-color: #555; color: #aaa; }

.edit-bar__save {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 7px 18px;
  background: #e0e0e0;
  color: #0a0a0a;
  border: none;
  border-radius: 3px;
  font-size: 11px;
  font-family: 'Space Mono', monospace;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  cursor: pointer;
  transition: background 0.12s, opacity 0.12s;
}

.edit-bar__save:hover { background: #fff; }
.edit-bar__save:disabled { opacity: 0.35; cursor: not-allowed; }
.edit-bar__save--paper { background: #d97706; color: #fff; }
.edit-bar__save--paper:hover { background: #f59e0b; }

.mode-toggle {
  display: flex;
  align-items: center;
  gap: 0;
  border: 1px solid #2a2a2a;
  border-radius: 3px;
  overflow: hidden;
  margin-right: 6px;
}

.mode-toggle__btn {
  padding: 5px 12px;
  background: none;
  border: none;
  font-family: 'Space Mono', monospace;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: #555;
  cursor: pointer;
  transition: background 0.12s, color 0.12s;
}

.mode-toggle__btn--active {
  background: #2a2a2a;
  color: #e0e0e0;
}

.mode-toggle__btn--paper.mode-toggle__btn--active {
  background: color-mix(in srgb, #d97706 20%, transparent);
  color: #d97706;
}

.paper-callout {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  background: color-mix(in srgb, #d97706 8%, transparent);
  border: 1px solid color-mix(in srgb, #d97706 30%, transparent);
  border-radius: 4px;
  font-family: 'Space Mono', monospace;
  font-size: 11px;
  color: #d97706;
  max-width: 740px;
  margin: 0 auto;
  width: 100%;
}

.paper-callout__icon { font-style: normal; flex-shrink: 0; }

.edit-page__body {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  align-items: stretch;
  max-width: 740px;
  margin: 0 auto;
  width: 100%;
}

.edit-page__left {
  position: static;
  max-height: none;
  overflow: visible;
}

.edit-page__right { min-width: 0; }

@media (max-width: 1000px) {
  .edit-page__body { max-width: 100%; }
}

.create-overlay {
  position: fixed;
  inset: 0;
  z-index: 100;
  background: rgba(10, 10, 10, 0.75);
  backdrop-filter: blur(4px);
  display: flex;
  align-items: center;
  justify-content: center;
}

.create-overlay__inner {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;
}

.create-overlay__label {
  font-family: 'Space Mono', monospace;
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--text-muted, #666);
}
</style>
