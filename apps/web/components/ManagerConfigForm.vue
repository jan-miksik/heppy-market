<template>
  <form @submit.prevent="handleSubmit" class="space-y-6">
    <!-- Name -->
    <div>
      <label class="block text-sm font-medium text-gray-400 mb-1">Name</label>
      <input
        v-model="form.name"
        type="text"
        maxlength="50"
        placeholder="Alpha Manager"
        class="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-white focus:outline-none focus:border-green-500"
        required
      />
    </div>

    <!-- LLM Model -->
    <div>
      <label class="block text-sm font-medium text-gray-400 mb-1">LLM Model</label>
      <select
        v-model="form.llmModel"
        class="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-white focus:outline-none focus:border-green-500"
      >
        <option v-for="model in models" :key="model.id" :value="model.id">{{ model.name }}</option>
      </select>
    </div>

    <!-- Temperature -->
    <div>
      <label class="block text-sm font-medium text-gray-400 mb-1">
        Temperature: {{ form.temperature.toFixed(1) }}
        <span class="text-xs text-gray-500 ml-2">Lower = more deterministic, Higher = more creative</span>
      </label>
      <input
        v-model.number="form.temperature"
        type="range"
        min="0" max="2" step="0.1"
        class="w-full accent-green-500"
      />
    </div>

    <!-- Decision Interval -->
    <div>
      <label class="block text-sm font-medium text-gray-400 mb-1">Decision Interval</label>
      <select
        v-model="form.decisionInterval"
        class="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-white focus:outline-none focus:border-green-500"
      >
        <option value="1h">Every 1 hour</option>
        <option value="4h">Every 4 hours</option>
        <option value="1d">Every 24 hours</option>
      </select>
    </div>

    <!-- Risk Parameters -->
    <fieldset class="border border-gray-700 rounded p-4">
      <legend class="text-sm font-medium text-gray-400 px-2">Risk Parameters</legend>
      <div class="space-y-4 mt-2">
        <div>
          <label class="block text-sm text-gray-400 mb-1">
            Max Total Drawdown: {{ (form.riskParams.maxTotalDrawdown * 100).toFixed(0) }}%
          </label>
          <input
            v-model.number="form.riskParams.maxTotalDrawdown"
            type="range" min="0.01" max="1" step="0.01"
            class="w-full accent-green-500"
          />
        </div>
        <div>
          <label class="block text-sm text-gray-400 mb-1">Max Agents: {{ form.riskParams.maxAgents }}</label>
          <input
            v-model.number="form.riskParams.maxAgents"
            type="range" min="1" max="20" step="1"
            class="w-full accent-green-500"
          />
        </div>
        <div>
          <label class="block text-sm text-gray-400 mb-1">
            Max Correlated Positions: {{ form.riskParams.maxCorrelatedPositions }}
          </label>
          <input
            v-model.number="form.riskParams.maxCorrelatedPositions"
            type="range" min="1" max="10" step="1"
            class="w-full accent-green-500"
          />
        </div>
      </div>
    </fieldset>

    <div v-if="error" class="text-red-400 text-sm">{{ error }}</div>

    <div class="flex gap-3">
      <button
        type="submit"
        :disabled="loading || !form.name.trim()"
        class="flex-1 bg-green-600 hover:bg-green-500 disabled:opacity-50 text-white font-medium py-2 px-4 rounded transition-colors"
      >
        {{ loading ? 'Saving…' : (isEdit ? 'Save Changes' : 'Create Manager') }}
      </button>
      <button
        v-if="onCancel"
        type="button"
        @click="onCancel"
        class="px-4 py-2 border border-gray-600 text-gray-400 hover:text-white rounded transition-colors"
      >
        Cancel
      </button>
    </div>
  </form>
</template>

<script setup lang="ts">
import { ref, reactive } from 'vue';

const props = defineProps<{
  initial?: {
    name?: string;
    llmModel?: string;
    temperature?: number;
    decisionInterval?: string;
    riskParams?: { maxTotalDrawdown: number; maxAgents: number; maxCorrelatedPositions: number };
  };
  isEdit?: boolean;
  onCancel?: () => void;
}>();

const emit = defineEmits<{
  (e: 'submit', value: {
    name: string;
    llmModel: string;
    temperature: number;
    decisionInterval: string;
    riskParams: { maxTotalDrawdown: number; maxAgents: number; maxCorrelatedPositions: number };
  }): void;
}>();

const loading = ref(false);
const error = ref('');

const form = reactive({
  name: props.initial?.name ?? '',
  llmModel: props.initial?.llmModel ?? 'nvidia/nemotron-3-nano-30b-a3b:free',
  temperature: props.initial?.temperature ?? 0.7,
  decisionInterval: props.initial?.decisionInterval ?? '1h',
  riskParams: {
    maxTotalDrawdown: props.initial?.riskParams?.maxTotalDrawdown ?? 0.2,
    maxAgents: props.initial?.riskParams?.maxAgents ?? 10,
    maxCorrelatedPositions: props.initial?.riskParams?.maxCorrelatedPositions ?? 3,
  },
});

// Fetch available models
const models = ref([{ id: 'nvidia/nemotron-3-nano-30b-a3b:free', name: 'Nvidia Nemotron Nano 30B (free)' }]);
try {
  const { data } = await useFetch<{ models: Array<{ id: string; name: string }> }>('/api/models');
  if (data.value?.models?.length) models.value = data.value.models;
} catch { /* use defaults */ }

async function handleSubmit() {
  error.value = '';
  if (!form.name.trim()) { error.value = 'Name is required'; return; }
  loading.value = true;
  try {
    emit('submit', { ...form, riskParams: { ...form.riskParams } });
  } finally {
    loading.value = false;
  }
}
</script>
