<script setup lang="ts">
import { ENTITY_NAME_MAX_CHARS, DEFAULT_FREE_AGENT_MODEL } from '@something-in-loop/shared';

const props = defineProps<{
  form: any;
  syncNameWithModel: boolean;
  persistModelAsDefault?: boolean;
  showPersistModelDefault?: boolean;
  modelCatalog: any;
  hasOwnKey: boolean;
  openRouterRedirecting?: boolean;
  isPersonaCustomized: boolean;
  selectedProfileId: string | null;
  selectedProfileDescription: string;
  type: 'agent' | 'manager';
  entityName?: string;
}>();

const emit = defineEmits<{
  (e: 'update:syncNameWithModel', val: boolean): void;
  (e: 'update:persistModelAsDefault', val: boolean): void;
  (e: 'profileSelected', profile: any): void;
  (e: 'connectOpenRouter'): void;
}>();
</script>

<template>
  <div class="basics-section">
    <!-- Name -->
    <div class="acf__name-row">
      <input
        v-model="form.name"
        class="acf__name-input"
        :placeholder="`${entityName || 'Agent'} name…`"
        :maxlength="ENTITY_NAME_MAX_CHARS"
        required
        @input="$emit('update:syncNameWithModel', false)"
      />
      <div class="acf__name-count">{{ form.name.length }}/{{ ENTITY_NAME_MAX_CHARS }}</div>
      <label class="acf__sync-check">
        <input :checked="syncNameWithModel" type="checkbox" @change="$emit('update:syncNameWithModel', ($event.target as HTMLInputElement).checked)" />
        <span>auto-name</span>
      </label>
    </div>

    <!-- LLM Model -->
    <div class="form-group">
      <label class="form-label" style="display: block; margin-bottom: 6px;">LLM Model</label>
      <ModelPickerField
        :model-value="form.llmModel ?? DEFAULT_FREE_AGENT_MODEL"
        :catalog="modelCatalog"
        :has-own-key="hasOwnKey"
        @update:model-value="form.llmModel = $event"
      >
        <template v-if="showPersistModelDefault" #corner>
          <label class="acf__sync-check">
            <input
              :checked="persistModelAsDefault"
              type="checkbox"
              @change="$emit('update:persistModelAsDefault', ($event.target as HTMLInputElement).checked)"
            />
            <span>set as default</span>
          </label>
        </template>
        <template #locked-message>
          <button
            type="button"
            :disabled="openRouterRedirecting"
            @click="$emit('connectOpenRouter')"
          >
            {{ openRouterRedirecting ? 'Redirecting…' : 'Connect your OpenRouter key' }}
          </button>
          to unlock paid models.
        </template>
      </ModelPickerField>
    </div>

    <!-- Persona style -->
    <div class="acf__section">
      <div class="acf__section-label">
        Persona style
        <span v-if="isPersonaCustomized" class="acf__custom-badge">✎ Custom</span>
      </div>
      <BehaviorProfilePicker :model-value="selectedProfileId" :type="type" @profile-selected="$emit('profileSelected', $event)" />
      <div v-if="selectedProfileDescription && !isPersonaCustomized" class="acf__profile-desc">
        {{ selectedProfileDescription }}
      </div>
    </div>
  </div>
</template>

<style scoped>
.acf__name-row { display: flex; align-items: center; gap: 10px; margin-bottom: 1.5rem; }
.acf__name-input { flex: 1; background: var(--surface, #141414); border: 1px solid var(--border, #2a2a2a); border-radius: 8px; padding: 10px 14px; font-size: 15px; font-weight: 600; color: var(--text, #e0e0e0); outline: none; transition: border-color 0.15s; }
.acf__name-input:focus { border-color: var(--accent, #7c6af7); }
.acf__name-count { font-size: 11px; color: var(--text-muted, #555); white-space: nowrap; font-variant-numeric: tabular-nums; }
.acf__sync-check { height: 1rem; display: flex; align-items: center; gap: 6px; font-size: 11px; color: var(--text-muted, #555); cursor: pointer; white-space: nowrap; margin-bottom: 0; }
.acf__section { display: flex; flex-direction: column; gap: 10px; margin-top: 2rem; }
.acf__section-label { font-size: 11px; font-weight: 700; letter-spacing: 0.07em; text-transform: uppercase; color: var(--text-muted, #555); display: flex; align-items: center; gap: 8px; }
.acf__profile-desc { font-size: 12px; color: var(--text-secondary, #888); line-height: 1.5; padding: 8px 12px; background: color-mix(in srgb, var(--accent, #7c6af7) 6%, transparent); border-left: 2px solid var(--accent, #7c6af7); border-radius: 0 6px 6px 0; }
.acf__custom-badge { font-size: 10px; font-weight: 600; padding: 2px 7px; border-radius: 4px; background: color-mix(in srgb, var(--warning, #f5a623) 15%, transparent); color: var(--warning, #f5a623); border: 1px solid color-mix(in srgb, var(--warning, #f5a623) 30%, transparent); text-transform: none; letter-spacing: 0; }
</style>
