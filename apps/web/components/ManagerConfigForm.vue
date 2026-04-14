<script setup lang="ts">
import { ENTITY_NAME_MAX_CHARS } from '@something-in-loop/shared';
import { useManagerConfigForm } from '~/features/managers/config/useManagerConfigForm';

import BasicsSection from '~/components/config/BasicsSection.vue';
import BehaviorSection from '~/components/config/BehaviorSection.vue';
import ManagerRiskSection from '~/components/config/ManagerRiskSection.vue';
import ManagerPromptPreviewPanel from '~/components/manager-config/ManagerPromptPreviewPanel.vue';

const props = defineProps<{
  initial?: any;
  isEdit?: boolean;
  managerId?: string;
  onCancel?: () => void;
  hideFooter?: boolean;
}>();

const emit = defineEmits<{
  (e: 'submit', value: any): void;
}>();

const {
  form,
  behavior,
  personaMd,
  selectedProfileId,
  selectedProfileDescription,
  isPersonaCustomized,
  hasOwnKey,
  modelCatalog,
  syncName,
  persistModelAsDefault,
  submitting,
  validationError,
  finetuneOpen,
  managerConfigOpen,
  liveSystemPrompt,
  liveEditableSetup,
  onProfileSelected,
  onPersonaEdited,
  restorePersona,
} = useManagerConfigForm({ initial: props.initial, isEdit: props.isEdit });

function handleSubmit() {
  validationError.value = '';
  if (!form.name.trim()) { validationError.value = 'Manager name is required'; return; }
  if (form.name.length > ENTITY_NAME_MAX_CHARS) { validationError.value = `Manager name must be at most ${ENTITY_NAME_MAX_CHARS} characters`; return; }
  
  submitting.value = true;
  try {
    emit('submit', {
      ...form,
      riskParams: { ...form.riskParams },
      behavior: behavior.value,
      profileId: selectedProfileId.value ?? undefined,
      personaMd: personaMd.value || undefined,
    });
  } finally {
    submitting.value = false;
  }
}

</script>

<template>
  <form id="manager-config-form" class="mcf" @submit.prevent="handleSubmit">
    <div v-if="validationError" class="alert alert-error">{{ validationError }}</div>
    <div class="mcf__paper-note">
      Managers are paper-only. They can create and control paper trading agents, not live or onchain agents.
    </div>

    <BasicsSection
      v-model:sync-name-with-model="syncName"
      v-model:persist-model-as-default="persistModelAsDefault"
      :form="form"
      :show-persist-model-default="!isEdit"
      :model-catalog="modelCatalog"
      :has-own-key="hasOwnKey"
      :is-persona-customized="isPersonaCustomized"
      :selected-profile-id="selectedProfileId"
      :selected-profile-description="selectedProfileDescription"
      type="manager"
      entity-name="Manager"
      @profile-selected="onProfileSelected"
    />

    <BehaviorSection
      v-model:finetune-open="finetuneOpen"
      v-model:behavior="behavior"
      :is-persona-customized="isPersonaCustomized"
      type="manager"
      @restore-persona="restorePersona"
    />

    <ManagerRiskSection
      v-model:manager-config-open="managerConfigOpen"
      :form="form"
    />

    <ManagerPromptPreviewPanel
      :manager-id="managerId"
      :is-edit="isEdit"
      :system-prompt="liveSystemPrompt"
      :editable-setup="liveEditableSetup"
      :persona-md="personaMd"
      :is-persona-customized="isPersonaCustomized"
      :initially-expanded="false"
      @update:persona-md="personaMd = $event"
      @edited="onPersonaEdited"
      @restore="restorePersona"
    />

    <!-- Footer -->
    <div v-if="!hideFooter" class="mcf__footer">
      <button v-if="onCancel" type="button" class="btn btn-ghost" @click="onCancel">Cancel</button>
      <button type="submit" class="btn btn-primary" :disabled="submitting">
        <span v-if="submitting" class="spinner" style="width:14px;height:14px;" />
        {{ isEdit ? 'Save Changes' : 'Create Paper Manager' }}
      </button>
    </div>
  </form>
</template>

<style scoped>
.mcf { display: flex; flex-direction: column; gap: 16px; }
.mcf__paper-note {
  padding: 10px 12px;
  border: 1px solid color-mix(in srgb, var(--accent, #74d38a) 26%, transparent);
  background: color-mix(in srgb, var(--accent, #74d38a) 10%, transparent);
  border-radius: var(--radius, 6px);
  color: var(--text-dim, #b0aba5);
  font-size: 12px;
}
.mcf__footer { display: flex; justify-content: flex-end; gap: 8px; padding-top: 4px; }
</style>
