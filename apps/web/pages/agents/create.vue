<script setup lang="ts">
definePageMeta({ ssr: false });
import { buildBehaviorSection, buildConstraintsSection, BASE_AGENT_PROMPT, buildJsonSchemaInstruction, AGENT_ROLE_SECTION } from '@something-in-loop/shared';
import type { CreateAgentPayload } from '~/composables/useAgents';
import AgentConfigForm from '~/components/AgentConfigForm.vue';
import { renderMarkdown } from '~/utils/markdown';

const router = useRouter();
const { request } = useApi();
const { createAgent, updateAgent, startAgent } = useAgents();
const { showNotification, clearNotification } = useNotification();
const {
  state: initiaState,
  openConnect,
  openWallet,
  openBridge,
  refresh,
  createAgentOnchain,
  depositShowcaseToken,
  withdrawShowcaseToken,
  mintShowcaseToken,
  enableAutoSign,
  disableAutoSign,
} = useInitiaBridge();

// ── Step state ──────────────────────────────────────────────────────────────
const step = ref<1 | 2>(1);
const fundAmount = ref('1000');
const createdAgentId = ref<string | null>(null);
const currentPaperBalance = ref(0);
const funding = ref(false);
const withdrawing = ref(false);
const bridging = ref(false);
const mintingFaucet = ref(false);
const faucetAmount = ref('1000');
const autoSignBusy = ref<'enable' | 'disable' | null>(null);
const autoSignStatusSinceMs = ref<number | null>(null);
const autoSignNowMs = ref(Date.now());
let autoSignStatusTimer: ReturnType<typeof setInterval> | null = null;

const creating = ref(false);
const onchainStatus = ref('');

const showMdPreview = ref(false);
const systemExpanded = ref(false);
const editingSetup = ref(false);
const editPersonaText = ref('');
const editBehaviorText = ref('');
const editRoleText = ref('');

const behaviorTextareaRef = ref<HTMLTextAreaElement | null>(null);
const personaTextareaRef = ref<HTMLTextAreaElement | null>(null);
const roleTextareaRef = ref<HTMLTextAreaElement | null>(null);

const configFormRef = ref<InstanceType<typeof AgentConfigForm> | null>(null);
const WALLET_STATE_TIMEOUT_MS = 30_000;
const WALLET_STATE_POLL_MS = 250;
const BRIDGE_SRC_CHAIN_ID = 'initiation-2';
const BRIDGE_SRC_DENOM = 'uinit';

function autoResize(el: HTMLTextAreaElement | null) {
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = `${el.scrollHeight + 20}px`;
}

function formatWei(wei: string | null | undefined): string | null {
  if (!wei) return null;
  try {
    const n = BigInt(wei);
    const e18 = 1_000_000_000_000_000_000n;
    const whole = n / e18;
    const frac = n % e18;
    return `${whole}.${frac.toString().padStart(18, '0').slice(0, 2)}`;
  } catch { return null; }
}

const walletDisplay = computed(() => formatWei(initiaState.value.walletBalanceWei));
const walletIusdDisplay = computed(() => formatWei(initiaState.value.walletShowcaseTokenBalanceWei));

function formatElapsedShort(ms: number): string {
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  return `${Math.floor(hr / 24)}d`;
}

const autoSignStatusBadgeText = computed(() => {
  const status = initiaState.value.autoSignEnabled ? 'enabled' : 'disabled';
  const sinceMs = autoSignStatusSinceMs.value;
  if (sinceMs === null) return status;
  return `${status} · ${formatElapsedShort(Math.max(0, autoSignNowMs.value - sinceMs))}`;
});

watch(
  [() => initiaState.value.ready, () => initiaState.value.autoSignEnabled],
  ([ready, enabled], previous) => {
    if (!ready) return;

    if (autoSignStatusSinceMs.value === null) {
      autoSignStatusSinceMs.value = Date.now();
      return;
    }

    const prevReady = previous?.[0] ?? false;
    const prevEnabled = previous?.[1];
    if (prevReady && prevEnabled !== enabled) {
      autoSignStatusSinceMs.value = Date.now();
    }
  },
);

onMounted(() => {
  autoSignStatusTimer = setInterval(() => {
    autoSignNowMs.value = Date.now();
  }, 1_000);
});

onUnmounted(() => {
  if (autoSignStatusTimer) {
    clearInterval(autoSignStatusTimer);
  }
});

// Live system prompt
const liveSystemPrompt = computed(() => BASE_AGENT_PROMPT + buildJsonSchemaInstruction());

const liveEditableSetup = computed(() => {
  const form = configFormRef.value;
  if (!form) return '';
  const roleSection = (form.isRoleCustomized && form.roleMd) ? form.roleMd : AGENT_ROLE_SECTION;
  const behaviorSection = (form.isBehaviorCustomized && form.behaviorMd)
    ? form.behaviorMd
    : buildBehaviorSection(form.behavior as any);
  const personaSection = form.personaMd ? '## Your Persona\n' + form.personaMd : '';
  const constraintsSection = buildConstraintsSection({
    pairs: form.form.pairs ?? [],
    maxPositionSizePct: form.form.maxPositionSizePct ?? 2,
    maxOpenPositions: form.form.maxOpenPositions ?? 3,
    stopLossPct: form.form.stopLossPct ?? 2,
    takeProfitPct: form.form.takeProfitPct ?? 3,
  });
  return [roleSection, behaviorSection, personaSection, constraintsSection].filter(Boolean).join('\n\n');
});

const liveBehaviorSection = computed(() => {
  const form = configFormRef.value;
  if (!form) return '';
  return buildBehaviorSection(form.behavior as any);
});

const liveConstraintsSection = computed(() => {
  const form = configFormRef.value;
  if (!form) return '';
  return buildConstraintsSection({
    pairs: form.form.pairs ?? [],
    maxPositionSizePct: form.form.maxPositionSizePct ?? 2,
    maxOpenPositions: form.form.maxOpenPositions ?? 3,
    stopLossPct: form.form.stopLossPct ?? 2,
    takeProfitPct: form.form.takeProfitPct ?? 3,
  });
});

const isPersonaCustomized = computed(() => configFormRef.value?.isPersonaCustomized ?? false);
const isBehaviorCustomized = computed(() => configFormRef.value?.isBehaviorCustomized ?? false);
const isRoleCustomized = computed(() => configFormRef.value?.isRoleCustomized ?? false);

// ── Inline setup editing ────────────────────────────────────────────────

function startEditingSetup() {
  editPersonaText.value = configFormRef.value?.personaMd ?? '';
  editBehaviorText.value = configFormRef.value?.behaviorMd || liveBehaviorSection.value;
  editRoleText.value = configFormRef.value?.roleMd || AGENT_ROLE_SECTION;
  editingSetup.value = true;
  nextTick(() => {
    autoResize(behaviorTextareaRef.value);
    autoResize(personaTextareaRef.value);
    autoResize(roleTextareaRef.value);
  });
}

function stopEditingSetup() { editingSetup.value = false; }

function onPersonaTextInput(event: Event) {
  const el = event.target as HTMLTextAreaElement;
  editPersonaText.value = el.value;
  if (configFormRef.value) { configFormRef.value.personaMd = el.value; configFormRef.value.isPersonaCustomized = true; }
  autoResize(el);
}
function resetPersona() {
  if (configFormRef.value) { configFormRef.value.restorePersona(); editPersonaText.value = configFormRef.value.personaMd ?? ''; }
}
function onBehaviorTextInput(event: Event) {
  const el = event.target as HTMLTextAreaElement;
  editBehaviorText.value = el.value;
  if (configFormRef.value) { configFormRef.value.behaviorMd = el.value; configFormRef.value.isBehaviorCustomized = true; }
  autoResize(el);
}
function resetBehavior() {
  if (configFormRef.value) { configFormRef.value.restoreBehavior(); editBehaviorText.value = liveBehaviorSection.value; }
}
function onRoleTextInput(event: Event) {
  const el = event.target as HTMLTextAreaElement;
  editRoleText.value = el.value;
  if (configFormRef.value) { configFormRef.value.roleMd = el.value; configFormRef.value.isRoleCustomized = true; }
  autoResize(el);
}
function resetRole() {
  if (configFormRef.value) { configFormRef.value.restoreRole(); editRoleText.value = AGENT_ROLE_SECTION; }
}

// ── Step navigation ────────────────────────────────────────────────────────

function goToStep(s: 1 | 2) {
  if (s === 2 && !createdAgentId.value) return;
  step.value = s;
}

// ── Step 1: capture config ─────────────────────────────────────────────────

async function handleNext(payload: Partial<CreateAgentPayload>) {
  creating.value = true;
  try {
    await ensureWalletConnected();

    if (!createdAgentId.value) {
      const agent = await createAgent({
        ...toCreateAgentPayload({ ...payload, paperBalance: 0 }),
        chain: 'initia',
        initiaWalletAddress: initiaState.value.initiaAddress ?? undefined,
      });
      createdAgentId.value = agent.id;
      currentPaperBalance.value = 0;
    }

    await ensureOnchainAgent({ forceCreate: true });
    await refresh();
    await syncInitiaState('create-step-onchain');
    step.value = 2;
    showNotification({
      type: 'success',
      title: 'Agent Created',
      message: 'Agent setup was created successfully. Continue with funding in step 2.',
    });
  } catch (e) {
    showNotification({
      type: 'error',
      title: 'Agent Creation Failed',
      message: extractApiError(e),
      durationMs: 8_000,
    });
  } finally {
    creating.value = false;
    onchainStatus.value = '';
  }
}

function handleCancel() {
  router.push('/agents');
}

// ── Step 2: fund agent ──────────────────────────────────────────────────────

function toCreateAgentPayload(payload: Partial<CreateAgentPayload>): CreateAgentPayload {
  if (
    !payload.name
    || !payload.pairs
    || !payload.strategies
    || !payload.analysisInterval
    || payload.paperBalance === undefined
    || payload.maxPositionSizePct === undefined
    || payload.stopLossPct === undefined
    || payload.takeProfitPct === undefined
    || payload.maxOpenPositions === undefined
    || !payload.llmModel
    || payload.temperature === undefined
    || payload.allowFallback === undefined
  ) {
    throw new Error('Missing required agent configuration');
  }
  return payload as CreateAgentPayload;
}

function clearFundingFeedback() {
  clearNotification();
}

function buildMetadataPointer() {
  const agentId = createdAgentId.value ?? `pending-${Date.now()}`;
  return {
    agentId,
    version: 1,
    configHash: `cfg_${Date.now().toString(16)}_${Math.random().toString(16).slice(2, 10)}`,
    labels: {
      source: 'initroot',
      flow: 'create-step-2',
    },
  };
}

async function syncInitiaState(trigger: string) {
  if (!createdAgentId.value || !initiaState.value.initiaAddress) return;
  try {
    await request(`/api/agents/${createdAgentId.value}/initia/sync`, {
      method: 'POST',
      body: {
        state: {
          walletAddress: initiaState.value.initiaAddress,
          evmAddress: initiaState.value.evmAddress ?? undefined,
          onchainAgentId: initiaState.value.onchainAgentId ?? undefined,
          chainOk: initiaState.value.chainOk,
          existsOnchain: initiaState.value.agentExists,
          autoSignEnabled: initiaState.value.autoSignEnabled,
          walletBalanceWei: initiaState.value.walletBalanceWei ?? undefined,
          walletShowcaseTokenBalanceWei: initiaState.value.walletShowcaseTokenBalanceWei ?? undefined,
          showcaseTokenBalanceWei: initiaState.value.showcaseTokenBalanceWei ?? undefined,
          vaultBalanceWei: initiaState.value.vaultBalanceWei ?? undefined,
          lastTxHash: initiaState.value.lastTxHash ?? undefined,
          syncTrigger: trigger,
        },
      },
      silent: true,
    });
  } catch (err) {
    console.warn('[create-flow] failed to sync initia state', err);
  }
}

async function ensureWalletConnected() {
  await refresh();
  // Only initiaAddress is required — it's the bech32 sender used in all tx signing.
  // evmAddress may be null if InterwovenKit hasn't resolved it for the current chain.
  if (initiaState.value.initiaAddress) return;

  await openConnect();

  const startedAt = Date.now();
  while (Date.now() - startedAt < WALLET_STATE_TIMEOUT_MS) {
    await refresh();
    if (initiaState.value.initiaAddress) return;
    await new Promise((resolve) => setTimeout(resolve, WALLET_STATE_POLL_MS));
  }

  throw new Error('Wallet connection was not detected. Finish wallet connect and try again.');
}

async function ensureOnchainAgent(opts?: { forceCreate?: boolean }) {
  if (!opts?.forceCreate && initiaState.value.agentExists) return;

  if (!initiaState.value.chainOk) {
    throw new Error('Local rollup chain is not reachable. Ensure the chain is running at the configured RPC endpoint.');
  }

  const metadataPointer = buildMetadataPointer();
  onchainStatus.value = 'Waiting for block confirmation…';
  const { txHash, onchainAgentId } = await createAgentOnchain(metadataPointer);

  if (onchainAgentId) {
    onchainStatus.value = 'Agent confirmed onchain';
  } else {
    // tx submitted but EVM RPC didn't confirm within polling window — do one final check
    onchainStatus.value = 'Confirming transaction…';
    await new Promise(r => setTimeout(r, 1_500));
    await refresh();
    if (!initiaState.value.agentExists) {
      throw new Error('Transaction submitted but agent not yet confirmed. Please check your wallet and try again.');
    }
    onchainStatus.value = 'Agent confirmed onchain';
  }

  if (createdAgentId.value && initiaState.value.initiaAddress && txHash) {
    try {
      await request(`/api/agents/${createdAgentId.value}/initia/link`, {
        method: 'POST',
        body: {
          initiaWalletAddress: initiaState.value.initiaAddress,
          evmAddress: initiaState.value.evmAddress ?? undefined,
          txHash,
          metadataPointer,
        },
        silent: true,
      });
    } catch (err) {
      console.warn('[create-flow] failed to persist initia link state', err);
    }
  }
}

async function handleDeposit() {
  if (!createdAgentId.value) return;
  const amt = Number(fundAmount.value);
  if (!Number.isFinite(amt) || amt <= 0) {
    showNotification({
      type: 'error',
      title: 'Invalid Amount',
      message: 'Enter a valid amount greater than zero.',
    });
    return;
  }
  clearFundingFeedback();
  funding.value = true;
  try {
    const balanceBeforeDeposit = currentPaperBalance.value;
    await ensureWalletConnected();
    await ensureOnchainAgent();
    const result = await depositShowcaseToken(String(amt));
    await refresh();
    currentPaperBalance.value += amt;
    await updateAgent(createdAgentId.value, { paperBalance: currentPaperBalance.value });
    await syncInitiaState('create-step-deposit');
    const shouldAutoStart = balanceBeforeDeposit <= 0 && currentPaperBalance.value > 0;
    let autoStartError: string | null = null;

    if (shouldAutoStart) {
      try {
        await startAgent(createdAgentId.value);
      } catch (err) {
        autoStartError = `Deposit succeeded, but auto-start failed: ${extractApiError(err)}`;
      }
      if (!autoStartError) {
        try {
          await request(`/api/agents/${createdAgentId.value}/analyze`, { method: 'POST', silent: true, timeout: 90_000 });
        } catch (err) {
          autoStartError = `Agent started, but the initial analysis failed: ${extractApiError(err)}`;
        }
      }
    }

    const txSuffix = result.txHash ? ` tx: ${result.txHash}` : '';
    if (autoStartError) {
      showNotification({
        type: 'error',
        title: 'Deposit Completed With Warning',
        message: `Deposited ${amt.toLocaleString()} iUSD-demo.${txSuffix}\n${autoStartError}`,
        durationMs: 8_500,
      });
    } else {
      showNotification({
        type: 'success',
        title: 'Deposit Successful',
        message: `Deposited ${amt.toLocaleString()} iUSD-demo.${txSuffix}${shouldAutoStart ? ' Agent started and first analysis triggered.' : ''}`,
      });
    }
  } catch (e) {
    showNotification({
      type: 'error',
      title: 'Deposit Failed',
      message: extractApiError(e),
      durationMs: 8_000,
    });
  } finally {
    funding.value = false;
  }
}

async function handleWithdraw() {
  if (!createdAgentId.value) return;
  const amt = Number(fundAmount.value);
  if (!Number.isFinite(amt) || amt <= 0) {
    showNotification({
      type: 'error',
      title: 'Invalid Amount',
      message: 'Enter a valid amount greater than zero.',
    });
    return;
  }
  clearFundingFeedback();
  withdrawing.value = true;
  try {
    await ensureWalletConnected();
    await ensureOnchainAgent();
    const result = await withdrawShowcaseToken(String(amt));
    await refresh();
    currentPaperBalance.value = Math.max(0, currentPaperBalance.value - amt);
    await updateAgent(createdAgentId.value, { paperBalance: currentPaperBalance.value });
    await syncInitiaState('create-step-withdraw');
    showNotification({
      type: 'success',
      title: 'Withdraw Successful',
      message: `Withdrew ${amt.toLocaleString()} iUSD-demo.${result.txHash ? ` tx: ${result.txHash}` : ''}`,
    });
  } catch (e) {
    showNotification({
      type: 'error',
      title: 'Withdraw Failed',
      message: extractApiError(e),
      durationMs: 8_000,
    });
  } finally {
    withdrawing.value = false;
  }
}

async function handleBridge() {
  clearFundingFeedback();
  bridging.value = true;
  try {
    await ensureWalletConnected();
    await openBridge({ srcChainId: BRIDGE_SRC_CHAIN_ID, srcDenom: BRIDGE_SRC_DENOM, quantity: '0' });
    showNotification({
      type: 'success',
      title: 'Bridge Opened',
      message: 'Bridge dialog opened. Continue the transfer flow in your wallet.',
    });
  } catch (e) {
    showNotification({
      type: 'error',
      title: 'Bridge Failed',
      message: extractApiError(e),
      durationMs: 8_000,
    });
  } finally {
    bridging.value = false;
  }
}

async function handleMintFaucet() {
  const amt = Number(faucetAmount.value);
  if (!Number.isFinite(amt) || amt <= 0) {
    showNotification({
      type: 'error',
      title: 'Invalid Faucet Amount',
      message: 'Enter a valid faucet amount greater than zero.',
    });
    return;
  }

  clearFundingFeedback();
  mintingFaucet.value = true;
  try {
    await ensureWalletConnected();
    const result = await mintShowcaseToken(String(amt));
    await refresh();
    await syncInitiaState('create-step-mint-iusd-faucet');
    showNotification({
      type: 'success',
      title: 'Faucet Mint Successful',
      message: `Minted ${amt.toLocaleString()} iUSD-demo.${result.txHash ? ` tx: ${result.txHash}` : ''}`,
    });
  } catch (e) {
    showNotification({
      type: 'error',
      title: 'Faucet Mint Failed',
      message: extractApiError(e),
      durationMs: 8_000,
    });
  } finally {
    mintingFaucet.value = false;
  }
}

async function handleToggleAutoSign() {
  if (!createdAgentId.value) return;
  const enabling = !initiaState.value.autoSignEnabled;
  clearFundingFeedback();
  autoSignBusy.value = enabling ? 'enable' : 'disable';
  try {
    await ensureWalletConnected();
    await ensureOnchainAgent();
    const result = enabling ? await enableAutoSign() : await disableAutoSign();
    await refresh();
    await syncInitiaState(enabling ? 'create-step-enable-autosign' : 'create-step-disable-autosign');
    showNotification({
      type: 'success',
      title: enabling ? 'Auto-Sign Enabled' : 'Auto-Sign Disabled',
      message: `${enabling ? 'Enabled' : 'Disabled'} auto-sign for this agent.${result.txHash ? ` tx: ${result.txHash}` : ''}`,
    });
  } catch (e) {
    showNotification({
      type: 'error',
      title: enabling ? 'Enable Auto-Sign Failed' : 'Disable Auto-Sign Failed',
      message: extractApiError(e),
      durationMs: 8_000,
    });
  } finally {
    autoSignBusy.value = null;
  }
}

function handleOpenAgent() {
  if (!createdAgentId.value) return;
  router.push(`/agents/${createdAgentId.value}`);
}
</script>

<template>
  <div class="edit-page">
    <!-- Sticky command bar -->
    <div class="edit-bar">
      <NuxtLink to="/agents" class="edit-bar__back">← Agents</NuxtLink>

      <!-- Centered step breadcrumbs -->
      <nav class="edit-bar__steps">
        <button
          class="step-item"
          :class="{ 'step-item--active': step === 1, 'step-item--done': step > 1 }"
          @click="goToStep(1)"
        >
          <span class="step-item__num">1</span>
          <span class="step-item__label">Configure agent</span>
        </button>
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
      </nav>

      <div class="edit-bar__actions">
        <template v-if="step === 1">
          <button type="button" class="edit-bar__cancel" @click="handleCancel">Cancel</button>
          <button type="submit" form="agent-config-form" class="edit-bar__save" :disabled="creating">
            <span v-if="creating" class="spinner" style="width:13px;height:13px;border-color:#fff3;border-top-color:#fff" />
            {{ onchainStatus || (creating ? 'Creating…' : 'Create Agent →') }}
          </button>
        </template>
        <template v-else>
          <button type="button" class="edit-bar__save" :disabled="!createdAgentId" @click="handleOpenAgent">
            Open Agent
          </button>
        </template>
      </div>
    </div>

    <!-- ── Step 1: Config form + prompt preview (v-show keeps form mounted) ── -->
    <div v-show="step === 1" class="edit-page__body">
      <div class="edit-page__left">
        <AgentConfigForm
          ref="configFormRef"
          hide-persona-editor
          hide-balance-input
          :hide-footer="true"
          @submit="handleNext"
          @cancel="handleCancel"
        />
      </div>

      <!-- Prompt preview -->
      <div class="edit-page__right">
        <div class="prompt-preview">
          <div class="prompt-preview__header">
            <span class="prompt-preview__title">Prompt Preview</span>
            <div class="prompt-preview__header-actions">
              <button
                class="btn btn-ghost btn-sm"
                style="margin-left: auto; font-size: 11px;"
                @click="showMdPreview = !showMdPreview"
              >
                {{ showMdPreview ? 'MD ●' : 'MD ○' }}
              </button>
            </div>
          </div>

          <div class="prompt-pills">
            <button class="prompt-pill prompt-pill--system" @click="systemExpanded = !systemExpanded">
              <span>[SYSTEM]</span>
              <span class="pill-chevron">{{ systemExpanded ? '▾' : '▸' }}</span>
            </button>
            <div v-if="systemExpanded" class="pill-content">
              <pre v-if="!showMdPreview" class="dec-code-block dec-code-block--scrollable">{{ liveSystemPrompt }}</pre>
              <!-- eslint-disable-next-line vue/no-v-html -->
              <div v-else class="dec-code-block dec-code-block--scrollable" v-html="renderMarkdown(liveSystemPrompt)" />
            </div>
            <button class="prompt-pill prompt-pill--market" disabled style="opacity: 0.4; cursor: default;">
              <span>[MARKET DATA]</span>
              <span style="font-size: 10px; font-weight: 400; text-transform: none; letter-spacing: 0;">&mdash; available after first run</span>
            </button>
          </div>

          <div class="prompt-section prompt-section--editable">
            <div class="prompt-section__toggle-row">
              <button class="prompt-section__toggle" style="flex:1">
                <span class="prompt-section__label">[EDITABLE SETUP]</span>
              </button>
              <button v-if="!editingSetup" class="btn btn-ghost btn-sm" style="margin-right:8px" @click="startEditingSetup">Edit</button>
              <button v-else class="btn btn-ghost btn-sm" style="margin-right:8px" @click="stopEditingSetup">Done</button>
            </div>

            <pre v-if="!editingSetup && !showMdPreview" class="prompt-section__content prompt-section__content--setup">{{ liveEditableSetup }}</pre>
            <!-- eslint-disable-next-line vue/no-v-html -->
            <div v-else-if="!editingSetup && showMdPreview" class="prompt-section__content prompt-section__content--setup" v-html="renderMarkdown(liveEditableSetup)" />

            <template v-else>
              <div class="setup-part">
                <div class="setup-part__label">
                  Role
                  <span v-if="isRoleCustomized" class="acf__custom-badge">Custom</span>
                  <span v-else class="setup-part__auto-tag">default</span>
                  <button v-if="isRoleCustomized" type="button" class="btn btn-ghost btn-sm" style="margin-left:8px" @click="resetRole">↺ Reset</button>
                </div>
                <textarea ref="roleTextareaRef" class="setup-part__textarea" :value="editRoleText" placeholder="Role section markdown…" @input="onRoleTextInput($event)" />
              </div>
              <div class="setup-part">
                <div class="setup-part__label">
                  Behavior profile
                  <span v-if="isBehaviorCustomized" class="acf__custom-badge">Custom</span>
                  <span v-else class="setup-part__auto-tag">auto-generated</span>
                  <button v-if="isBehaviorCustomized" type="button" class="btn btn-ghost btn-sm" style="margin-left:8px" @click="resetBehavior">↺ Reset</button>
                </div>
                <textarea ref="behaviorTextareaRef" class="setup-part__textarea" :value="editBehaviorText" placeholder="Behavior profile markdown…" @input="onBehaviorTextInput($event)" />
              </div>
              <div class="setup-part">
                <div class="setup-part__label">
                  Persona
                  <span v-if="isPersonaCustomized" class="acf__custom-badge">Custom</span>
                  <button v-if="isPersonaCustomized" type="button" class="btn btn-ghost btn-sm" style="margin-left:8px" @click="resetPersona">↺ Reset</button>
                </div>
                <textarea ref="personaTextareaRef" class="setup-part__textarea" :value="editPersonaText" placeholder="Your persona markdown…" @input="onPersonaTextInput($event)" />
              </div>
              <div class="setup-part setup-part--readonly">
                <div class="setup-part__label">Constraints <span class="setup-part__auto-tag">auto-generated</span></div>
                <pre v-if="!showMdPreview" class="prompt-section__content">{{ liveConstraintsSection }}</pre>
                <!-- eslint-disable-next-line vue/no-v-html -->
                <div v-else class="prompt-section__content" v-html="renderMarkdown(liveConstraintsSection)" />
              </div>
            </template>
          </div>
        </div>
      </div>
    </div>

    <!-- ── Step 2: Fund ────────────────────────────────────────────────── -->
    <div v-if="step === 2" class="fund-step">
      <div class="fund-step__surface">
        <div class="fund-step__header">
          <span class="fund-step__title">Fund agent vault</span>
        </div>

        <p class="fund-step__desc">
          Agent is created with zero balance by default. Fund from wallet to proceed.
        </p>

        <div class="fund-step__wallet-row">
          <span class="fund-step__bal-key">agent paper balance</span>
          <span class="fund-step__bal-val">{{ currentPaperBalance.toLocaleString() }} iUSD-demo</span>
        </div>

        <div v-if="walletIusdDisplay" class="fund-step__wallet-row">
          <span class="fund-step__bal-key">wallet balance</span>
          <span class="fund-step__bal-val">{{ walletIusdDisplay }} iUSD-demo</span>
        </div>

        <div class="fund-step__input-row">
          <input
            v-model="fundAmount"
            type="number"
            min="0.0001"
            step="0.0001"
            class="fund-step__input"
            placeholder="1000"
            :disabled="funding || withdrawing || bridging || mintingFaucet || autoSignBusy !== null"
            @focus="clearFundingFeedback"
          >
          <span class="fund-step__currency">iUSD-demo</span>
        </div>

        <div class="fund-step__faucet">
          <div class="fund-step__faucet-title">iUSD-demo faucet</div>
          <div class="fund-step__input-row">
            <input
              v-model="faucetAmount"
              type="number"
              min="0.0001"
              step="0.0001"
              class="fund-step__input"
              placeholder="1000"
              :disabled="funding || withdrawing || bridging || mintingFaucet || autoSignBusy !== null"
              @focus="clearFundingFeedback"
            >
            <span class="fund-step__currency">iUSD-demo</span>
          </div>
          <button
            class="fund-step__btn fund-step__btn--faucet"
            :disabled="funding || withdrawing || bridging || mintingFaucet || autoSignBusy !== null"
            @click="handleMintFaucet"
          >
            <span v-if="mintingFaucet" class="spinner" style="width:12px;height:12px;" />
            {{ mintingFaucet ? 'Minting…' : 'Mint Faucet Tokens' }}
          </button>
        </div>

        <div class="fund-step__actions">
          <button
            class="fund-step__btn fund-step__btn--primary"
            :disabled="funding || withdrawing || bridging || mintingFaucet || autoSignBusy !== null"
            @click="handleDeposit"
          >
            <span v-if="funding" class="spinner" style="width:12px;height:12px;border-color:#0003;border-top-color:#0a0a0a" />
            {{ funding ? 'Depositing…' : 'Deposit' }}
          </button>
          <button
            class="fund-step__btn fund-step__btn--ghost"
            :disabled="funding || withdrawing || bridging || mintingFaucet || autoSignBusy !== null"
            @click="handleWithdraw"
          >
            <span v-if="withdrawing" class="spinner" style="width:12px;height:12px;" />
            {{ withdrawing ? 'Withdrawing…' : 'Withdraw' }}
          </button>
          <button
            class="fund-step__btn fund-step__btn--bridge"
            :disabled="funding || withdrawing || bridging || mintingFaucet || autoSignBusy !== null"
            @click="handleBridge"
          >
            <span v-if="bridging" class="spinner" style="width:12px;height:12px;" />
            {{ bridging ? 'Opening…' : 'Bridge' }}
          </button>
        </div>

        <div class="fund-step__bridge-note">
          <div class="fund-step__bridge-note-title">Hackathon bridge note</div>
          <p>
            Local dev limitation: Interwoven Bridge resolves registered chain IDs only, so your local appchain or token route may not render.
            We still keep bridge in this flow because it demonstrates the hackathon path: bridge assets from L1 to appchain, then deposit into the agent vault.
            This improves onboarding speed, liquidity access, and immediate utility.
          </p>
        </div>
      </div>
    </div>
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
}

/* ── Command bar ──────────────────────────────────────────────────── */
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

/* Steps centered absolutely so they're always at 50% regardless of left/right content width */
.edit-bar__steps {
  position: absolute;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 10px;
  pointer-events: none; /* reset on children */
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

.step-item--active {
  opacity: 1;
}
.step-item--done {
  opacity: 0.55;
}
.step-item--done:not(:disabled):hover { opacity: 0.8; }
.step-item--pending {
  opacity: 0.25;
}

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
.step-item--active .step-item__label {
  color: var(--text, #e0e0e0);
}

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

/* ── Step 1 body ────────────────────────────────────────────────── */
.edit-page__body {
  display: flex;
  flex-direction: column;
  gap: 5rem;
  align-items: stretch;
  max-width: 740px;
  margin: 0 auto;
  width: 100%;
}
.edit-page__left { position: static; max-height: none; overflow: visible; }
.edit-page__right { min-width: 0; }

/* ── Step 2 fund ────────────────────────────────────────────────── */
.fund-step {
  max-width: 440px;
  margin: 0 auto;
  width: 100%;
}

.fund-step__surface {
  background: var(--surface, #141414);
  border: 1px solid var(--border, #2a2a2a);
  border-radius: 6px;
  padding: 20px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.fund-step__header {
  display: flex;
  align-items: center;
  gap: 10px;
}

.fund-step__title {
  flex: 1;
  font-family: 'Space Mono', monospace;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--text-muted, #555);
}

.fund-step__badge {
  font-family: 'Space Mono', monospace;
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.07em;
  text-transform: uppercase;
  color: #f59e0b;
  background: color-mix(in srgb, #f59e0b 12%, transparent);
  border: 1px solid color-mix(in srgb, #f59e0b 25%, transparent);
  padding: 2px 7px;
  border-radius: 2px;
}

.fund-step__desc {
  font-family: 'JetBrains Mono', monospace;
  font-size: 11px;
  line-height: 1.6;
  color: var(--text-muted, #555);
  margin: 0;
}

.fund-step__wallet-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 10px;
  background: color-mix(in srgb, var(--border, #2a2a2a) 20%, transparent);
  border-radius: 3px;
}

.fund-step__bal-key {
  font-family: 'JetBrains Mono', monospace;
  font-size: 10px;
  color: var(--text-muted, #555);
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.fund-step__bal-val {
  font-family: 'JetBrains Mono', monospace;
  font-size: 13px;
  color: var(--text, #e0e0e0);
}

.fund-step__input-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.fund-step__input {
  flex: 1;
  height: 38px;
  background: var(--bg, #0a0a0a);
  border: 1px solid var(--border, #2a2a2a);
  border-radius: 3px;
  color: var(--text, #e0e0e0);
  font-family: 'JetBrains Mono', monospace;
  font-size: 14px;
  padding: 0 12px;
  outline: none;
  transition: border-color 0.12s;
}
.fund-step__input:focus { border-color: var(--accent, #7c6af7); }
.fund-step__input:disabled { opacity: 0.4; }

.fund-step__currency {
  font-family: 'Space Mono', monospace;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.06em;
  color: var(--text-muted, #555);
  white-space: nowrap;
}

.fund-step__actions {
  display: flex;
  gap: 8px;
}

.fund-step__btn {
  flex: 1;
  height: 34px;
  border-radius: 3px;
  border: 1px solid var(--border, #2a2a2a);
  background: transparent;
  color: var(--text, #e0e0e0);
  font-family: 'Space Mono', monospace;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  cursor: pointer;
  transition: opacity 0.12s, border-color 0.12s, background 0.12s;
}

.fund-step__btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.fund-step__btn--primary {
  background: #e0e0e0;
  color: #0a0a0a;
  border-color: transparent;
}

.fund-step__btn--primary:not(:disabled):hover {
  background: #fff;
}

.fund-step__btn--ghost:not(:disabled):hover {
  border-color: #555;
  color: #fff;
}

.fund-step__btn--bridge {
  color: #f59e0b;
  border-color: color-mix(in srgb, #f59e0b 40%, var(--border, #2a2a2a));
}

.fund-step__btn--bridge:not(:disabled):hover {
  background: color-mix(in srgb, #f59e0b 10%, transparent);
}

.fund-step__faucet {
  border: 1px solid color-mix(in srgb, #4ade80 30%, var(--border, #2a2a2a));
  background: color-mix(in srgb, #4ade80 9%, transparent);
  border-radius: 4px;
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.fund-step__faucet-title {
  font-family: 'Space Mono', monospace;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: #4ade80;
}

.fund-step__btn--faucet {
  border-color: color-mix(in srgb, #4ade80 45%, var(--border, #2a2a2a));
  color: #4ade80;
  background: color-mix(in srgb, #4ade80 10%, transparent);
}

.fund-step__btn--faucet:not(:disabled):hover {
  background: color-mix(in srgb, #4ade80 16%, transparent);
}

.fund-step__autosign {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  border: 1px solid var(--border, #2a2a2a);
  border-radius: 4px;
  background: color-mix(in srgb, var(--border, #2a2a2a) 12%, transparent);
  padding: 10px;
}

.fund-step__autosign-copy {
  min-width: 0;
}

.fund-step__autosign-title {
  font-family: 'Space Mono', monospace;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-muted, #777);
}

.fund-step__autosign-title-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.fund-step__autosign-badge {
  display: inline-flex;
  align-items: center;
  padding: 2px 6px;
  border-radius: 999px;
  border: 1px solid var(--border, #2a2a2a);
  font-family: 'JetBrains Mono', monospace;
  font-size: 9px;
  line-height: 1;
  letter-spacing: 0.03em;
  text-transform: uppercase;
}

.fund-step__autosign-badge--on {
  color: #4ade80;
  border-color: color-mix(in srgb, #4ade80 45%, var(--border, #2a2a2a));
  background: color-mix(in srgb, #4ade80 12%, transparent);
}

.fund-step__autosign-badge--off {
  color: var(--text-muted, #999);
  border-color: color-mix(in srgb, #999 38%, var(--border, #2a2a2a));
  background: color-mix(in srgb, #999 8%, transparent);
}

.fund-step__autosign-desc {
  margin-top: 3px;
  font-family: 'JetBrains Mono', monospace;
  font-size: 10px;
  line-height: 1.5;
  color: var(--text-muted, #9a9a9a);
}

.fund-step__btn--autosign {
  flex: 0 0 auto;
  min-width: 168px;
}

.fund-step__btn--autosign:not(:disabled):hover {
  border-color: #555;
  color: #fff;
}

.fund-step__btn--autosign-on {
  border-color: color-mix(in srgb, #4ade80 45%, var(--border, #2a2a2a));
  color: #4ade80;
}

.fund-step__meta {
  display: flex;
  align-items: center;
  gap: 6px;
  padding-top: 2px;
  border-top: 1px solid var(--border, #1e1e1e);
}
.fund-step__meta-item {
  font-family: 'JetBrains Mono', monospace;
  font-size: 10px;
  color: var(--text-muted, #444);
}
.fund-step__meta-sep {
  color: var(--border, #333);
  font-size: 10px;
}

.fund-step__bridge-note {
  border: 1px solid color-mix(in srgb, #f59e0b 30%, var(--border, #2a2a2a));
  background: color-mix(in srgb, #f59e0b 8%, transparent);
  border-radius: 4px;
  padding: 10px;
}

.fund-step__bridge-note-title {
  font-family: 'Space Mono', monospace;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: #f59e0b;
  margin-bottom: 6px;
}

.fund-step__bridge-note p {
  margin: 0;
  font-family: 'JetBrains Mono', monospace;
  font-size: 10px;
  line-height: 1.6;
  color: var(--text-muted, #a7a7a7);
}

/* ── Prompt preview ──────────────────────────────────────────────── */
.prompt-preview {
  background: var(--surface, #141414);
  border: 1px solid var(--border, #2a2a2a);
  border-radius: 8px;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}
.prompt-preview__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  border-bottom: 1px solid var(--border, #2a2a2a);
  background: color-mix(in srgb, var(--border, #2a2a2a) 30%, transparent);
  gap: 12px;
}
.prompt-preview__header-actions { display: flex; align-items: center; gap: 8px; }
.prompt-preview__title {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.07em;
  text-transform: uppercase;
  color: var(--text-muted, #555);
}

.prompt-section { border-bottom: 1px solid var(--border, #1e1e1e); }
.prompt-section:last-child { border-bottom: none; }
.prompt-section--editable { flex: 1; }
.prompt-section__toggle {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 16px;
  background: none;
  border: none;
  color: var(--text-muted, #555);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  cursor: pointer;
  text-align: left;
  gap: 8px;
}
.prompt-section__toggle:hover { background: color-mix(in srgb, var(--border) 20%, transparent); }
.prompt-section__toggle-row {
  display: flex;
  align-items: center;
  border-bottom: 1px solid var(--border, #1e1e1e);
}
.prompt-section__label { flex: 1; }
.prompt-section__content {
  font-family: 'JetBrains Mono', monospace;
  font-size: 11px;
  line-height: 1.6;
  color: var(--text-secondary, #aaa);
  padding: 12px 16px;
  white-space: pre-wrap;
  word-break: break-word;
  margin: 0;
  background: color-mix(in srgb, var(--border, #2a2a2a) 10%, transparent);
}
.prompt-section__content--setup { overflow-y: auto; }

.prompt-pills { display: flex; flex-direction: column; gap: 4px; padding: 8px 10px 8px 12px; }
.prompt-pill {
  display: flex;
  justify-content: flex-start;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  font-size: 11px;
  font-family: 'Space Mono', monospace;
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
.prompt-pill:hover { opacity: 0.75; }
.prompt-pill--system { color: var(--text-muted); }
.prompt-pill--market { color: #f59e0b; }
.pill-chevron { flex-shrink: 0; font-size: 12px; }
.pill-content { padding: 0 10px 8px 18px; }

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
.dec-code-block--scrollable { overflow-y: auto; }

.setup-part { padding: 12px 16px; border-bottom: 1px solid var(--border, #1e1e1e); }
.setup-part:last-child { border-bottom: none; }
.setup-part--readonly .prompt-section__content { opacity: 0.55; }
.setup-part__label {
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.07em;
  text-transform: uppercase;
  color: var(--text-muted, #555);
  margin-bottom: 8px;
  display: flex;
  align-items: center;
  gap: 8px;
}
.setup-part__auto-tag {
  font-size: 9px;
  font-weight: 400;
  color: var(--text-muted, #444);
  text-transform: none;
  letter-spacing: 0;
}
.setup-part__textarea {
  width: 100%;
  min-height: 140px;
  height: auto;
  background: var(--surface, #141414);
  border: 1px solid var(--border, #2a2a2a);
  border-radius: 4px;
  padding: 10px 12px;
  font-family: 'JetBrains Mono', monospace;
  font-size: 11px;
  line-height: 1.6;
  color: var(--text, #e0e0e0);
  resize: vertical;
  overflow-y: auto;
  outline: none;
  box-sizing: border-box;
  transition: border-color 0.15s;
}
.setup-part__textarea:focus { border-color: var(--accent, #7c6af7); }

.acf__custom-badge {
  font-size: 10px;
  font-weight: 600;
  padding: 2px 7px;
  border-radius: 3px;
  background: color-mix(in srgb, var(--warning, #f5a623) 15%, transparent);
  color: var(--warning, #f5a623);
  border: 1px solid color-mix(in srgb, var(--warning, #f5a623) 30%, transparent);
}

@media (max-width: 1000px) {
  .edit-page__body { max-width: 100%; }
}
</style>
