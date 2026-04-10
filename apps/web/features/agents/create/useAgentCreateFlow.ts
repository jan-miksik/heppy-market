import { computed, ref } from 'vue';
import type { CreateAgentPayload } from '~/composables/useAgents';
import { useAutoSignConsent } from '~/composables/useAutoSignConsent';

const WALLET_STATE_TIMEOUT_MS = 30_000;
const WALLET_STATE_POLL_MS = 250;
const BRIDGE_SRC_CHAIN_ID = 'initiation-2';
const BRIDGE_SRC_DENOM = 'uinit';

function formatWei(wei: string | null | undefined): string | null {
  if (!wei) return null;
  try {
    const n = BigInt(wei);
    const e18 = 1_000_000_000_000_000_000n;
    const whole = n / e18;
    const frac = n % e18;
    return `${whole}.${frac.toString().padStart(18, '0').slice(0, 2)}`;
  } catch {
    return null;
  }
}

function requireCreateAgentPayload(payload: Partial<CreateAgentPayload>): CreateAgentPayload {
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

export function useAgentCreateFlow() {
  const router = useRouter();
  const { request } = useApi();
  const { createAgent, updateAgent, startAgent } = useAgents();
  const { showNotification, clearNotification } = useNotification();
  const {
    state: initiaState,
    openConnect,
    openBridge,
    refresh,
    createAgentOnchain,
    depositShowcaseToken,
    withdrawShowcaseToken,
    mintShowcaseToken,
    enableAutoSign,
  } = useInitiaBridge();
  const autoSignMgr = useAutoSign();
  const {
    consentModalOpen,
    runWithAutoSignCheck,
    handleConsentProceed,
    handleConsentCancel,
  } = useAutoSignConsent({ autoSignMgr, enableAutoSign });

  const step = ref<1 | 2>(1);
  const fundAmount = ref('1000');
  const faucetAmount = ref('1000');
  const createdAgentId = ref<string | null>(null);
  const currentPaperBalance = ref(0);
  const creating = ref(false);
  const funding = ref(false);
  const withdrawing = ref(false);
  const bridging = ref(false);
  const mintingFaucet = ref(false);
  const onchainStatus = ref('');

  const walletIusdDisplay = computed(() => formatWei(initiaState.value.walletShowcaseTokenBalanceWei));
  const fundingBusy = computed(() =>
    funding.value || withdrawing.value || bridging.value || mintingFaucet.value,
  );

  function goToStep(nextStep: 1 | 2) {
    if (nextStep === 2 && !createdAgentId.value) return;
    step.value = nextStep;
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

  async function ensureOnchainAgent(options?: { forceCreate?: boolean; autoSign?: boolean }) {
    if (!options?.forceCreate && initiaState.value.agentExists) return;

    if (!initiaState.value.chainOk) {
      throw new Error('Local rollup chain is not reachable. Ensure the chain is running at the configured RPC endpoint.');
    }

    const metadataPointer = buildMetadataPointer();
    onchainStatus.value = 'Waiting for block confirmation...';
    const { txHash, onchainAgentId } = await createAgentOnchain(metadataPointer, { autoSign: options?.autoSign });

    if (onchainAgentId) {
      onchainStatus.value = 'Agent confirmed onchain';
    } else {
      onchainStatus.value = 'Confirming transaction...';
      await new Promise((resolve) => setTimeout(resolve, 1_500));
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

  async function handleNext(payload: Partial<CreateAgentPayload>) {
    creating.value = true;
    try {
      await ensureWalletConnected();

      if (!createdAgentId.value) {
        const agent = await createAgent({
          ...requireCreateAgentPayload({ ...payload, paperBalance: 0 }),
          chain: 'initia',
          initiaWalletAddress: initiaState.value.initiaAddress ?? undefined,
        });
        createdAgentId.value = agent.id;
        currentPaperBalance.value = 0;
      }

      await ensureOnchainAgent({ forceCreate: true, autoSign: false });
      await refresh();
      await syncInitiaState('create-step-onchain');
      step.value = 2;
      showNotification({
        type: 'success',
        title: 'Agent Created',
        message: 'Agent setup was created successfully. Continue with funding in step 2.',
      });
    } catch (err) {
      showNotification({
        type: 'error',
        title: 'Agent Creation Failed',
        message: extractApiError(err),
        durationMs: 8_000,
      });
    } finally {
      creating.value = false;
      onchainStatus.value = '';
    }
  }

  async function handleDeposit() {
    if (!createdAgentId.value) return;
    const amount = Number(fundAmount.value);
    if (!Number.isFinite(amount) || amount <= 0) {
      showNotification({
        type: 'error',
        title: 'Invalid Amount',
        message: 'Enter a valid amount greater than zero.',
      });
      return;
    }

    clearFundingFeedback();
    await runWithAutoSignCheck('depositShowcaseToken', async () => {
      funding.value = true;
      try {
        const balanceBeforeDeposit = currentPaperBalance.value;
        await ensureWalletConnected();
        const autoSign = autoSignMgr.isEnabled('depositShowcaseToken') && autoSignMgr.chainAutoSignEnabled.value;
        await ensureOnchainAgent({ autoSign });
        const result = await depositShowcaseToken(String(amount));
        await refresh();
        currentPaperBalance.value += amount;
        await updateAgent(createdAgentId.value!, { paperBalance: currentPaperBalance.value });
        await syncInitiaState('create-step-deposit');

        const shouldAutoStart = balanceBeforeDeposit <= 0 && currentPaperBalance.value > 0;
        let autoStartError: string | null = null;
        if (shouldAutoStart) {
          try {
            await startAgent(createdAgentId.value!);
          } catch (err) {
            autoStartError = `Deposit succeeded, but auto-start failed: ${extractApiError(err)}`;
          }
          if (!autoStartError) {
            request(`/api/agents/${createdAgentId.value!}/analyze`, {
              method: 'POST',
              silent: true,
              timeout: 90_000,
            }).catch((err) => {
              console.warn('[create-flow] background initial analysis failed:', err);
            });
          }
        }

        const txSuffix = result.txHash ? ` tx: ${result.txHash}` : '';
        if (autoStartError) {
          showNotification({
            type: 'error',
            title: 'Deposit Completed With Warning',
            message: `Deposited ${amount.toLocaleString()} iUSD-demo.${txSuffix}\n${autoStartError}`,
            durationMs: 8_500,
          });
        } else {
          showNotification({
            type: 'success',
            title: 'Deposit Successful',
            message: `Deposited ${amount.toLocaleString()} iUSD-demo.${txSuffix}${shouldAutoStart ? ' Agent started and first analysis triggered.' : ''}`,
          });
        }
      } catch (err) {
        showNotification({
          type: 'error',
          title: 'Deposit Failed',
          message: extractApiError(err),
          durationMs: 8_000,
        });
      } finally {
        funding.value = false;
      }
    });
  }

  async function handleWithdraw() {
    if (!createdAgentId.value) return;
    const amount = Number(fundAmount.value);
    if (!Number.isFinite(amount) || amount <= 0) {
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
      const result = await withdrawShowcaseToken(String(amount));
      await refresh();
      currentPaperBalance.value = Math.max(0, currentPaperBalance.value - amount);
      await updateAgent(createdAgentId.value, { paperBalance: currentPaperBalance.value });
      await syncInitiaState('create-step-withdraw');
      showNotification({
        type: 'success',
        title: 'Withdraw Successful',
        message: `Withdrew ${amount.toLocaleString()} iUSD-demo.${result.txHash ? ` tx: ${result.txHash}` : ''}`,
      });
    } catch (err) {
      showNotification({
        type: 'error',
        title: 'Withdraw Failed',
        message: extractApiError(err),
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
    } catch (err) {
      showNotification({
        type: 'error',
        title: 'Bridge Failed',
        message: extractApiError(err),
        durationMs: 8_000,
      });
    } finally {
      bridging.value = false;
    }
  }

  async function handleMintFaucet() {
    const amount = Number(faucetAmount.value);
    if (!Number.isFinite(amount) || amount <= 0) {
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
      const result = await mintShowcaseToken(String(amount));
      await refresh();
      await syncInitiaState('create-step-mint-iusd-faucet');
      showNotification({
        type: 'success',
        title: 'Faucet Mint Successful',
        message: `Minted ${amount.toLocaleString()} iUSD-demo.${result.txHash ? ` tx: ${result.txHash}` : ''}`,
      });
    } catch (err) {
      showNotification({
        type: 'error',
        title: 'Faucet Mint Failed',
        message: extractApiError(err),
        durationMs: 8_000,
      });
    } finally {
      mintingFaucet.value = false;
    }
  }

  function handleCancel() {
    router.push('/agents');
  }

  function handleOpenAgent() {
    if (!createdAgentId.value) return;
    router.push(`/agents/${createdAgentId.value}`);
  }

  return {
    step,
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
  };
}
