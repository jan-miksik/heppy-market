<script setup lang="ts">
import { ENTITY_NAME_MAX_CHARS, DEFAULT_FREE_AGENT_MODEL } from '@something-in-loop/shared';
import { useAgentConfigForm } from '~/features/agents/config/useAgentConfigForm';

import BasicsSection from '~/components/config/BasicsSection.vue';
import BehaviorSection from '~/components/config/BehaviorSection.vue';
import PersonaSection from '~/components/config/PersonaSection.vue';
import TradingConfigSection from '~/components/config/TradingConfigSection.vue';

const props = defineProps<{
  initialValues?: any;
  hidePersonaEditor?: boolean;
  hideFooter?: boolean;
  hideBalanceInput?: boolean;
}>();

const emit = defineEmits<{
  submit: [payload: any];
  cancel: [];
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
  openRouterRedirecting,
  syncNameWithModel,
  persistModelAsDefault,
  submitting,
  validationError,
  configOpen,
  finetuneOpen,
  personaMdOpen,
  AVAILABLE_PAIRS,
  onProfileSelected,
  onPersonaEdited,
  restorePersona,
  togglePair,
  buildSubmitPayload,
  handleConnectOpenRouter,
  initialSubmitPayload,
  isEditing,
} = useAgentConfigForm({ initialValues: props.initialValues });

async function handleSubmit() {
  if (!form.name.trim()) { validationError.value = 'Agent name is required'; return; }
  if (form.name.length > ENTITY_NAME_MAX_CHARS) { validationError.value = `Agent name must be at most ${ENTITY_NAME_MAX_CHARS} characters`; return; }
  if (!form.pairs.length) { validationError.value = 'Select at least one pair'; return; }
  validationError.value = '';
  submitting.value = true;
  
  const full = buildSubmitPayload();

  if (isEditing.value && initialSubmitPayload.value) {
    const base = initialSubmitPayload.value as unknown as Record<string, unknown>;
    const next = full as unknown as Record<string, unknown>;
    const changed: Record<string, unknown> = {};
    for (const key of Object.keys(next)) {
      const a = base[key];
      const b = next[key];
      const same = (typeof a === 'object' || typeof b === 'object')
        ? JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
        : a === b;
      if (!same) changed[key] = b;
    }
    emit('submit', changed);
  } else {
    emit('submit', full);
  }
  submitting.value = false;
}

defineExpose({ form, behavior, personaMd, restorePersona });
</script>

<template>
  <form id="agent-config-form" class="acf" @submit.prevent="handleSubmit">
    <div v-if="validationError" class="alert alert-error">{{ validationError }}</div>

    <BasicsSection
      v-model:sync-name-with-model="syncNameWithModel"
      v-model:persist-model-as-default="persistModelAsDefault"
      :form="form"
      :show-persist-model-default="!isEditing"
      :model-catalog="modelCatalog"
      :has-own-key="hasOwnKey"
      :open-router-redirecting="openRouterRedirecting"
      :is-persona-customized="isPersonaCustomized"
      :selected-profile-id="selectedProfileId"
      :selected-profile-description="selectedProfileDescription"
      type="agent"
      entity-name="Agent"
      @profile-selected="onProfileSelected"
      @connect-open-router="handleConnectOpenRouter"
    />

    <BehaviorSection
      v-model:finetune-open="finetuneOpen"
      v-model:behavior="behavior"
      :is-persona-customized="isPersonaCustomized"
      type="agent"
      @restore-persona="restorePersona"
    />

    <PersonaSection
      v-model:persona-md="personaMd"
      v-model:persona-md-open="personaMdOpen"
      :is-persona-customized="isPersonaCustomized"
      :hide-persona-editor="hidePersonaEditor"
      @persona-edited="onPersonaEdited"
      @restore-persona="restorePersona"
    />

    <TradingConfigSection
      v-model:config-open="configOpen"
      :form="form"
      :hide-balance-input="hideBalanceInput"
      :AVAILABLE_PAIRS="AVAILABLE_PAIRS"
      @toggle-pair="togglePair"
    />

    <!-- Footer -->
    <div v-if="!hideFooter" class="acf__footer">
      <button type="button" class="btn btn-ghost" @click="$emit('cancel')">Cancel</button>
      <button type="submit" class="btn btn-primary" :disabled="submitting">
        <span v-if="submitting" class="spinner" style="width:14px;height:14px;" />
        {{ isEditing ? 'Save Changes' : 'Create Agent' }}
      </button>
    </div>
  </form>
</template>

<style scoped>
.acf { display: flex; flex-direction: column; gap: 16px; }
.acf__footer {
  position: sticky;
  bottom: 0;
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 0 4px;
  background: var(--bg, #0a0a0a);
  border-top: 1px solid var(--border, #1e1e1e);
  margin-top: 8px;
  z-index: 2;
}
</style>
