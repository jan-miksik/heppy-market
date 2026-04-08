import { computed, ref } from 'vue';

export const ON_CHAIN_ACTIONS = [
  { key: 'createAgentOnchain', label: 'Create Agent', description: 'Deploy your agent contract on-chain' },
  { key: 'mintShowcaseToken', label: 'Mint iUSD-demo', description: 'Mint iUSD-demo tokens from the faucet' },
  { key: 'depositShowcaseToken', label: 'Deposit iUSD-demo', description: 'Deposit iUSD-demo tokens into the vault' },
  { key: 'withdrawShowcaseToken', label: 'Withdraw iUSD-demo', description: 'Withdraw iUSD-demo tokens from the vault' },
  { key: 'authorizeExecutor', label: 'Authorize Executor', description: 'Grant execution permissions to the executor' },
  { key: 'executeTick', label: 'Execute Tick', description: 'Manually trigger agent analysis cycle' },
] as const satisfies { key: string; label: string; description: string }[];

export type OnChainActionKey = (typeof ON_CHAIN_ACTIONS)[number]['key'];

const PREFS_KEY = 'heppy:autosign:prefs';
const DISMISSED_KEY = 'heppy:autosign:dismissed';

function readStorage(key: string): Record<string, boolean> {
  if (!import.meta.client) return {};
  try {
    return JSON.parse(localStorage.getItem(key) ?? '{}') as Record<string, boolean>;
  } catch {
    return {};
  }
}

function writeStorage(key: string, val: Record<string, boolean>): void {
  if (!import.meta.client) return;
  localStorage.setItem(key, JSON.stringify(val));
}

// Module-level singleton state — all callers share the same reactive refs
const prefs = ref<Record<string, boolean>>(readStorage(PREFS_KEY));
const dismissed = ref<Record<string, boolean>>(readStorage(DISMISSED_KEY));

export function useAutoSign() {
  // Lazy import to avoid circular deps — useInitiaBridge is a singleton itself
  const { state } = useInitiaBridge();

  const chainAutoSignEnabled = computed(() => state.value.autoSignEnabled);

  const anyEnabled = computed(() =>
    ON_CHAIN_ACTIONS.some(a => prefs.value[a.key] === true),
  );

  function isEnabled(actionKey: string): boolean {
    return prefs.value[actionKey] === true;
  }

  function setEnabled(actionKey: string, val: boolean): void {
    prefs.value = { ...prefs.value, [actionKey]: val };
    writeStorage(PREFS_KEY, prefs.value);
    // Reset dismissed so the consent modal re-appears if user later clicks the action
    if (!val) {
      dismissed.value = { ...dismissed.value, [actionKey]: false };
      writeStorage(DISMISSED_KEY, dismissed.value);
    }
  }

  function isDismissed(actionKey: string): boolean {
    return dismissed.value[actionKey] === true;
  }

  function setDismissed(actionKey: string, val: boolean): void {
    dismissed.value = { ...dismissed.value, [actionKey]: val };
    writeStorage(DISMISSED_KEY, dismissed.value);
  }

  return {
    ON_CHAIN_ACTIONS,
    isEnabled,
    setEnabled,
    isDismissed,
    setDismissed,
    anyEnabled,
    chainAutoSignEnabled,
  };
}
