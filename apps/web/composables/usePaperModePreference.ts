export type PaperMode = 'live' | 'all' | 'paper';

const PAPER_MODE_STORAGE_KEY = 'heppy:paperMode';
const LEGACY_PAPER_MODE_KEYS = [
  'heppy:trades:paperMode',
  'heppy:agents:paperMode',
] as const;
const LEGACY_BOOLEAN_KEYS = [
  'heppy:trades:showPaperAgents',
  'heppy:agents:showPaperAgents',
] as const;

function normalizePaperMode(value: string | null): PaperMode | null {
  if (value === 'live' || value === 'all' || value === 'paper') return value;
  return null;
}

function readStoredPaperMode(): PaperMode | null {
  if (!import.meta.client) return null;

  const primary = normalizePaperMode(localStorage.getItem(PAPER_MODE_STORAGE_KEY));
  if (primary) return primary;

  for (const key of LEGACY_PAPER_MODE_KEYS) {
    const legacyMode = normalizePaperMode(localStorage.getItem(key));
    if (!legacyMode) continue;
    localStorage.setItem(PAPER_MODE_STORAGE_KEY, legacyMode);
    return legacyMode;
  }

  for (const key of LEGACY_BOOLEAN_KEYS) {
    const legacyValue = localStorage.getItem(key);
    if (legacyValue === 'true') {
      localStorage.setItem(PAPER_MODE_STORAGE_KEY, 'all');
      return 'all';
    }
    if (legacyValue === 'false') {
      localStorage.setItem(PAPER_MODE_STORAGE_KEY, 'live');
      return 'live';
    }
  }

  return null;
}

export function usePaperModePreference() {
  const paperModePreference = useState<PaperMode | null>('paper-mode-preference', () => null);
  const initialized = useState<boolean>('paper-mode-preference:initialized', () => false);

  function initPaperModePreference() {
    if (!import.meta.client || initialized.value) return;
    paperModePreference.value = readStoredPaperMode();
    initialized.value = true;
  }

  function setPaperModePreference(value: PaperMode) {
    paperModePreference.value = value;
    if (!import.meta.client) return;
    localStorage.setItem(PAPER_MODE_STORAGE_KEY, value);
  }

  if (import.meta.client) {
    initPaperModePreference();

    const syncFromStorage = (event: StorageEvent) => {
      if (event.key !== PAPER_MODE_STORAGE_KEY) return;
      paperModePreference.value = normalizePaperMode(event.newValue);
    };

    onMounted(() => {
      window.addEventListener('storage', syncFromStorage);
    });

    onUnmounted(() => {
      window.removeEventListener('storage', syncFromStorage);
    });
  }

  return {
    paperModePreference,
    setPaperModePreference,
  };
}
