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
  toppingUpGas,
  onchainStatus,
  walletIusdDisplay,
  walletGasDisplay,
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
  handleTopUpGas,
  handleCancel,
  handleOpenAgent,
} = useAgentCreateFlow();

const runtimeConfig = useRuntimeConfig();
const isLocalhost = !runtimeConfig.public.simulateNonLocalhost
  && typeof window !== 'undefined'
  && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1');

isPaper.value = !isLocalhost;

const liveBlockedModalOpen = ref(false);

function handleLiveClick() {
  if (!isLocalhost) {
    isPaper.value = false;
    liveBlockedModalOpen.value = true;
    return;
  }
  isPaper.value = false;
}

function backToPaper() {
  liveBlockedModalOpen.value = false;
  isPaper.value = true;
}
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
            <div class="mode-toggle__slider" :class="{ 'mode-toggle__slider--paper': isPaper }" />
            <button
              class="mode-toggle__btn"
              :class="{ 'mode-toggle__btn--active': !isPaper }"
              type="button"
              @click="handleLiveClick"
            >Live</button>
            <button
              class="mode-toggle__btn"
              :class="{ 'mode-toggle__btn--active': isPaper, 'mode-toggle__btn--paper': isPaper }"
              type="button"
              @click="isPaper = true"
            >Paper</button>
          </div>
          <button type="button" class="edit-bar__cancel" @click="handleCancel">Cancel</button>
          <button
            type="submit"
            form="agent-config-form"
            class="edit-bar__save"
            :class="{ 'edit-bar__save--paper': isPaper }"
            :disabled="creating || (!isPaper && !isLocalhost)"
            @click="!isPaper && !isLocalhost ? liveBlockedModalOpen = true : undefined"
          >
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
        :wallet-gas-display="walletGasDisplay"
        :busy="fundingBusy"
        :funding="funding"
        :withdrawing="withdrawing"
        :bridging="bridging"
        :minting-faucet="mintingFaucet"
        :topping-up-gas="toppingUpGas"
        @deposit="handleDeposit"
        @withdraw="handleWithdraw"
        @bridge="handleBridge"
        @mint-faucet="handleMintFaucet"
        @top-up-gas="handleTopUpGas"
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
    <Transition name="live-blocked">
      <div v-if="liveBlockedModalOpen" class="live-blocked-overlay" @click.self="liveBlockedModalOpen = false">
        <div class="live-blocked-modal" role="dialog" aria-modal="true">
          <div class="live-blocked-modal__header">
            <span class="live-blocked-modal__tag">ON-CHAIN AGENT</span>
            <button class="live-blocked-modal__close" type="button" @click="liveBlockedModalOpen = false">✕</button>
          </div>
          <p class="live-blocked-modal__body">
            On-chain agents are not yet implemented on this website. If you want to see how the flow looks like for an on-chain agent, please run this app on your localhost. Instructions on how to do it are on <a href="https://github.com/jan-miksik/init-root/tree/hackathon-initia?tab=readme-ov-file#how-to-run-locally" target="_blank" rel="noopener noreferrer" class="live-blocked-modal__link">GitHub</a>. Anyway, besides the on-chain actions the live agent is very similar to a paper agent.
          </p>
          <button class="live-blocked-modal__back" type="button" @click="backToPaper">
            ← Go back to Paper Agent
          </button>
        </div>
      </div>
    </Transition>
  </Teleport>

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
  position: relative;
  display: flex;
  align-items: stretch;
  gap: 0;
  border: 1px solid #2a2a2a;
  border-radius: 3px;
  overflow: hidden;
  margin-right: 6px;
}

.mode-toggle__slider {
  position: absolute;
  inset-block: 0;
  left: 0;
  width: 50%;
  background: #2a2a2a;
  transition: transform 0.22s cubic-bezier(0.4, 0, 0.2, 1), background 0.22s;
  z-index: 0;
  pointer-events: none;
}

.mode-toggle__slider--paper {
  transform: translateX(100%);
  background: color-mix(in srgb, #d97706 22%, transparent);
}

.mode-toggle__btn {
  position: relative;
  z-index: 1;
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
  transition: color 0.22s;
}

.mode-toggle__btn--active {
  color: #e0e0e0;
}

.mode-toggle__btn--paper.mode-toggle__btn--active {
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

/* Live blocked modal */
.live-blocked-overlay {
  position: fixed;
  inset: 0;
  z-index: 200;
  background: rgba(10, 10, 10, 0.8);
  backdrop-filter: blur(6px);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
}

.live-blocked-modal {
  background: #111;
  border: 1px solid #2a2a2a;
  border-top: 2px solid #e0e0e0;
  max-width: 480px;
  width: 100%;
  padding: 24px;
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.live-blocked-modal__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.live-blocked-modal__tag {
  font-family: 'Space Mono', monospace;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--text-muted, #666);
  border: 1px solid #2a2a2a;
  padding: 3px 8px;
}

.live-blocked-modal__close {
  background: none;
  border: none;
  color: #555;
  font-size: 14px;
  cursor: pointer;
  padding: 2px 6px;
  transition: color 0.12s;
  font-family: 'Space Mono', monospace;
}

.live-blocked-modal__close:hover { color: #e0e0e0; }

.live-blocked-modal__body {
  font-family: 'Space Mono', monospace;
  font-size: 12px;
  line-height: 1.75;
  color: #aaa;
  margin: 0;
}

.live-blocked-modal__link {
  color: #e0e0e0;
  text-decoration: underline;
  text-underline-offset: 3px;
  transition: color 0.12s;
}

.live-blocked-modal__link:hover { color: var(--accent, #7c6af7); }

.live-blocked-modal__back {
  align-self: flex-start;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 16px;
  background: color-mix(in srgb, #d97706 15%, transparent);
  border: 1px solid color-mix(in srgb, #d97706 40%, transparent);
  color: #d97706;
  font-family: 'Space Mono', monospace;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  cursor: pointer;
  transition: background 0.12s, border-color 0.12s, color 0.12s;
}

.live-blocked-modal__back:hover {
  background: color-mix(in srgb, #d97706 25%, transparent);
  border-color: #d97706;
  color: #f59e0b;
}

/* Transition */
.live-blocked-enter-active,
.live-blocked-leave-active {
  transition: opacity 0.18s;
}

.live-blocked-enter-from,
.live-blocked-leave-to {
  opacity: 0;
}
</style>
