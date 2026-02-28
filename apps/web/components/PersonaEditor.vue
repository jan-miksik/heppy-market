<script setup lang="ts">
const props = defineProps<{
  modelValue: string;
  loading?: boolean;
  showActions?: boolean;  // default true — detail pages need Save/Reset
}>();

const emit = defineEmits<{
  'update:modelValue': [v: string];
  save: [v: string];
  reset: [];
  edited: [];          // fired only on user input, not programmatic updates
}>();

const showActions = computed(() => props.showActions !== false);

const showPreview = ref(false);
const localValue = ref(props.modelValue);

watch(() => props.modelValue, (v) => { localValue.value = v; });

const charCount = computed(() => localValue.value.length);
const isOverLimit = computed(() => charCount.value > 4000);

function handleInput(e: Event) {
  const v = (e.target as HTMLTextAreaElement).value;
  localValue.value = v;
  emit('update:modelValue', v);
  emit('edited');
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
  <div class="pe">
    <div class="pe__toolbar">
      <button class="btn btn-ghost btn-sm" type="button" @click="showPreview = !showPreview">
        {{ showPreview ? 'Edit' : 'Preview' }}
      </button>
      <template v-if="showActions">
        <button class="btn btn-ghost btn-sm" type="button" :disabled="loading" @click="emit('reset')">
          Reset to default
        </button>
        <button class="btn btn-primary btn-sm" type="button" :disabled="loading || isOverLimit" @click="emit('save', localValue)">
          {{ loading ? 'Saving…' : 'Save Persona' }}
        </button>
      </template>
    </div>

    <div v-if="showPreview" class="pe__preview" v-html="renderMd(localValue)" />
    <textarea
      v-else
      class="pe__textarea"
      :value="localValue"
      placeholder="Write your agent's persona here…"
      @input="handleInput"
    />

    <div class="pe__footer">
      <span :class="isOverLimit ? 'pe__chars--over' : 'pe__chars'">{{ charCount }}/4000</span>
    </div>
  </div>
</template>

<style scoped>
.pe { display: flex; flex-direction: column; gap: 8px; }
.pe__toolbar {
  display: flex;
  align-items: center;
  gap: 6px;
}
.pe__textarea {
  width: 100%;
  min-height: 260px;
  font-family: 'JetBrains Mono', monospace;
  font-size: 12px;
  background: var(--surface, #111);
  color: var(--text, #e0e0e0);
  border: 1px solid var(--border, #2a2a2a);
  border-radius: 8px;
  padding: 12px;
  resize: vertical;
  box-sizing: border-box;
  line-height: 1.6;
  transition: border-color 0.15s;
}
.pe__textarea:focus {
  outline: none;
  border-color: var(--accent, #7c6af7);
}
.pe__preview {
  min-height: 260px;
  padding: 16px;
  background: var(--surface, #111);
  border: 1px solid var(--border, #2a2a2a);
  border-radius: 8px;
  font-size: 13px;
  line-height: 1.6;
}
.pe__footer { text-align: right; }
.pe__chars { font-size: 11px; color: var(--text-muted, #555); }
.pe__chars--over { font-size: 11px; color: var(--red, #f44336); font-weight: 600; }
</style>
