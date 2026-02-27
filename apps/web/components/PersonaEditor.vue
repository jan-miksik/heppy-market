<script setup lang="ts">
const props = defineProps<{
  modelValue: string;
  loading?: boolean;
}>();

const emit = defineEmits<{
  'update:modelValue': [v: string];
  save: [v: string];
  reset: [];
}>();

const showPreview = ref(false);
const localValue = ref(props.modelValue);

watch(() => props.modelValue, (v) => { localValue.value = v; });

const charCount = computed(() => localValue.value.length);
const isOverLimit = computed(() => charCount.value > 4000);

function handleInput(e: Event) {
  const v = (e.target as HTMLTextAreaElement).value;
  localValue.value = v;
  emit('update:modelValue', v);
}

function renderMd(md: string): string {
  return md
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^# (.+)$/gm, '<h1>$1</h1>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/^- (.+)$/gm, '<li>$1</li>')
    .replace(/\n\n/g, '</p><p>');
}
</script>

<template>
  <div class="persona-editor">
    <div class="persona-editor__toolbar">
      <div class="persona-editor__warning">
        ⚠️ This markdown is injected directly into the agent's system prompt. Keep it focused on trading behavior.
      </div>
      <div class="persona-editor__actions">
        <button class="btn btn-ghost btn-sm" type="button" @click="showPreview = !showPreview">
          {{ showPreview ? 'Edit' : 'Preview' }}
        </button>
        <button class="btn btn-ghost btn-sm" type="button" :disabled="loading" @click="emit('reset')">
          Reset to default
        </button>
        <button class="btn btn-primary btn-sm" type="button" :disabled="loading || isOverLimit" @click="emit('save', localValue)">
          {{ loading ? 'Saving...' : 'Save Persona' }}
        </button>
      </div>
    </div>

    <div v-if="showPreview" class="persona-editor__preview" v-html="renderMd(localValue)" />
    <textarea
      v-else
      class="persona-editor__textarea"
      :value="localValue"
      placeholder="Write your agent's persona here..."
      @input="handleInput"
    />

    <div class="persona-editor__footer">
      <span :class="isOverLimit ? 'char-count--over' : 'char-count'">{{ charCount }}/4000 characters</span>
    </div>
  </div>
</template>

<style scoped>
.persona-editor { display: flex; flex-direction: column; gap: 8px; }
.persona-editor__toolbar { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; flex-wrap: wrap; }
.persona-editor__warning { font-size: 12px; color: var(--warning, #f5a623); padding: 6px 10px; background: color-mix(in srgb, var(--warning, #f5a623) 10%, transparent); border-radius: 6px; border: 1px solid color-mix(in srgb, var(--warning, #f5a623) 30%, transparent); flex: 1; }
.persona-editor__actions { display: flex; gap: 8px; flex-shrink: 0; }
.persona-editor__textarea { width: 100%; min-height: 320px; font-family: monospace; font-size: 13px; background: var(--card-bg, #111); color: var(--text, #e0e0e0); border: 1px solid var(--border, #2a2a2a); border-radius: 8px; padding: 12px; resize: vertical; box-sizing: border-box; }
.persona-editor__preview { min-height: 320px; padding: 16px; background: var(--card-bg, #111); border: 1px solid var(--border, #2a2a2a); border-radius: 8px; font-size: 13px; line-height: 1.6; }
.persona-editor__footer { text-align: right; }
.char-count { font-size: 12px; color: var(--text-secondary, #888); }
.char-count--over { font-size: 12px; color: var(--danger, #f44336); font-weight: 600; }
</style>
