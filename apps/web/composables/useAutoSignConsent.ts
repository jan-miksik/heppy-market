import { ref } from 'vue';

export function useAutoSignConsent(options: {
  autoSignMgr: ReturnType<typeof useAutoSign>;
  enableAutoSign: () => Promise<unknown>;
}) {
  const { autoSignMgr, enableAutoSign } = options;
  const consentModalOpen = ref(false);
  const consentActionKey = ref('');
  let pendingAction: (() => Promise<void>) | null = null;

  async function runWithAutoSignCheck(key: string, fn: () => Promise<void>) {
    if (consentModalOpen.value) return;
    if (autoSignMgr.shouldPrompt(key)) {
      pendingAction = fn;
      consentActionKey.value = key;
      consentModalOpen.value = true;
      return;
    }
    await fn();
  }

  async function handleConsentProceed(useAutoSignChoice: boolean, dontShowAgain: boolean) {
    const key = consentActionKey.value;
    consentModalOpen.value = false;
    autoSignMgr.setEnabled(key, useAutoSignChoice);
    autoSignMgr.setDismissed(key, dontShowAgain);

    if (useAutoSignChoice && !autoSignMgr.chainAutoSignEnabled.value) {
      try {
        await enableAutoSign();
      } catch {
        // Fall back to a regular signed flow if enabling auto-sign fails.
      }
    }

    const fn = pendingAction;
    pendingAction = null;
    if (fn) await fn();
  }

  function handleConsentCancel() {
    consentModalOpen.value = false;
    pendingAction = null;
  }

  return {
    consentModalOpen,
    runWithAutoSignCheck,
    handleConsentProceed,
    handleConsentCancel,
  };
}
