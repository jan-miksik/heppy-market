<script setup lang="ts">
const props = defineProps<{
  open: boolean;
}>();

const emit = defineEmits<{
  proceed: [useAutoSign: boolean, dontShowAgain: boolean];
  cancel: [];
}>();

const enableForAction = ref(false);
const dontShowAgain = ref(false);

// Reset local state each time the modal opens
watch(
  () => props.open,
  (val) => {
    if (val) {
      enableForAction.value = false;
      dontShowAgain.value = false;
    }
  },
);

function handleEnable() {
  enableForAction.value = true;
  emit('proceed', enableForAction.value, dontShowAgain.value);
}
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="modal-overlay" @click.self="emit('cancel')">
      <div class="modal autosign-consent-modal" @click.stop>
        <div class="modal-header">
          <span class="modal-title">Auto-Sign</span>
          <button class="btn btn-ghost btn-xs" @click="emit('cancel')">✕</button>
        </div>
        <div class="modal-body">
          <p class="autosign-desc">
            With auto-sign, you only approve actions once in Interwoven, no need to confirm again in your wallet.
            <br><br>
            Interwoven approvals are time-limited and can expire, so you may need to renew auto-sign later.
            <br><br>
            You can edit Auto-Sign also in settings.
          </p>
        </div>
        <div class="modal-footer">
          <label class="autosign-check-row autosign-check-row-footer">
            <input v-model="dontShowAgain" type="checkbox" class="autosign-checkbox" />
            <span>Don&apos;t show this again</span>
          </label>
          <div class="autosign-actions">
            <button class="btn btn-ghost btn-sm" @click="emit('cancel')">Cancel</button>
            <button class="btn btn-primary btn-sm" @click="handleEnable">Enable</button>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.autosign-consent-modal {
  max-width: 420px;
  width: calc(100vw - 48px);
}

.autosign-consent-modal .modal-header,
.autosign-consent-modal .modal-footer {
  border: none;
}

.autosign-desc {
  font-size: 13px;
  color: var(--text-dim);
  line-height: 1.6;
  margin-bottom: var(--space-md);
}

.autosign-check-row {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  cursor: pointer;
  font-size: 13px;
  color: var(--text);
  user-select: none;
}

.autosign-checkbox {
  flex-shrink: 0;
  accent-color: var(--accent);
  width: 14px;
  height: 14px;
  cursor: pointer;
}

.modal-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-md);
}

.autosign-actions {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
}

.autosign-check-row-footer {
  flex-shrink: 0;
}
</style>
