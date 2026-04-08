<script setup lang="ts">
const props = defineProps<{
  open: boolean;
  actionKey: string;
  actionLabel: string;
}>();

const emit = defineEmits<{
  proceed: [useAutoSign: boolean];
  cancel: [];
}>();

const enableForAction = ref(true);
const dontShowAgain = ref(false);

// Reset local state each time the modal opens
watch(
  () => props.open,
  (val) => {
    if (val) {
      enableForAction.value = true;
      dontShowAgain.value = false;
    }
  },
);

function handleContinue() {
  emit('proceed', enableForAction.value);
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
            Signing this transaction automatically lets you skip wallet popups
            for <strong>{{ actionLabel }}</strong> in the future. A session key
            will be registered on-chain once and can be revoked at any time in
            Settings.
          </p>
          <label class="autosign-check-row">
            <input v-model="enableForAction" type="checkbox" class="autosign-checkbox" />
            <span>Enable auto-sign for <strong>{{ actionLabel }}</strong></span>
          </label>
          <label class="autosign-check-row">
            <input v-model="dontShowAgain" type="checkbox" class="autosign-checkbox" />
            <span>Don't show this again for {{ actionLabel }}</span>
          </label>
          <p class="autosign-note">
            You can always change auto-sign preferences in Settings → Auto-Sign.
          </p>
        </div>
        <div class="modal-footer">
          <button class="btn btn-ghost btn-sm" @click="emit('cancel')">Cancel</button>
          <button class="btn btn-primary btn-sm" @click="handleContinue">Continue</button>
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

.autosign-desc {
  font-size: 13px;
  color: var(--text-dim);
  line-height: 1.6;
  margin-bottom: var(--space-md);
}

.autosign-check-row {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 10px 0;
  cursor: pointer;
  font-size: 13px;
  color: var(--text);
  border-top: 1px solid var(--border);
}

.autosign-check-row:last-of-type {
  border-bottom: 1px solid var(--border);
}

.autosign-checkbox {
  flex-shrink: 0;
  margin-top: 2px;
  accent-color: var(--accent);
  width: 14px;
  height: 14px;
  cursor: pointer;
}

.autosign-note {
  font-size: 11px;
  color: var(--text-dim);
  margin-top: var(--space-sm);
  line-height: 1.5;
}
</style>
