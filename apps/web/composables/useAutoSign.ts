import { computed, ref } from 'vue';

const PREFS_KEY = 'heppy:autosign:prefs';
const DISMISSED_KEY = 'heppy:autosign:dismissed';
const ENABLED_FIELD = 'enabled';
const DISMISSED_FIELD = 'dismissed';

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
const currentTimeMs = ref(import.meta.client ? Date.now() : 0);
let timeTickerStarted = false;

function ensureTimeTicker() {
  if (!import.meta.client || timeTickerStarted) return;
  timeTickerStarted = true;
  window.setInterval(() => {
    currentTimeMs.value = Date.now();
  }, 1_000);
}

function parseStoredDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function useAutoSign() {
  // Lazy import to avoid circular deps — useInitiaBridge is a singleton itself
  const { state } = useInitiaBridge();
  ensureTimeTicker();

  const chainAutoSignExpiresAt = computed(() => parseStoredDate(state.value.autoSignExpiresAt));
  const chainAutoSignExpired = computed(() => {
    const expiresAt = chainAutoSignExpiresAt.value;
    if (!expiresAt) return false;
    return currentTimeMs.value >= expiresAt.getTime();
  });
  const chainAutoSignConfigured = computed(() => state.value.autoSignConfiguredOnchain);
  const chainAutoSignGrantEnabled = computed(() =>
    state.value.autoSignGrantEnabled && !chainAutoSignExpired.value,
  );
  const chainAutoSignEnabled = computed(() =>
    chainAutoSignConfigured.value && chainAutoSignGrantEnabled.value,
  );
  const chainAutoSignNeedsRenewal = computed(() =>
    chainAutoSignConfigured.value && !chainAutoSignEnabled.value,
  );

  const anyEnabled = computed(() => prefs.value[ENABLED_FIELD] === true);

  function isEnabled(_actionKey: string): boolean {
    return prefs.value[ENABLED_FIELD] === true;
  }

  function setEnabled(_actionKey: string, val: boolean): void {
    prefs.value = { ...prefs.value, [ENABLED_FIELD]: val };
    writeStorage(PREFS_KEY, prefs.value);
    // Reset dismissed so the consent modal re-appears if user later opts out.
    if (!val) {
      dismissed.value = { ...dismissed.value, [DISMISSED_FIELD]: false };
      writeStorage(DISMISSED_KEY, dismissed.value);
    }
  }

  function isDismissed(_actionKey: string): boolean {
    return dismissed.value[DISMISSED_FIELD] === true;
  }

  function setDismissed(_actionKey: string, val: boolean): void {
    dismissed.value = { ...dismissed.value, [DISMISSED_FIELD]: val };
    writeStorage(DISMISSED_KEY, dismissed.value);
  }

  function shouldPrompt(actionKey: string): boolean {
    if (chainAutoSignNeedsRenewal.value) return true;
    return !chainAutoSignEnabled.value && !isDismissed(actionKey);
  }

  return {
    isEnabled,
    setEnabled,
    isDismissed,
    setDismissed,
    anyEnabled,
    chainAutoSignEnabled,
    chainAutoSignConfigured,
    chainAutoSignExpiresAt,
    chainAutoSignExpired,
    chainAutoSignGrantEnabled,
    chainAutoSignNeedsRenewal,
    shouldPrompt,
  };
}
