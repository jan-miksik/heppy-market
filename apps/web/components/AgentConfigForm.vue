<script setup lang="ts">
import type { CreateAgentPayload } from '~/composables/useAgents';

const emit = defineEmits<{
  submit: [payload: CreateAgentPayload];
  cancel: [];
}>();

const form = reactive<CreateAgentPayload & { pairs: string[] }>({
  name: '',
  autonomyLevel: 'guided',
  pairs: ['WETH/USDC', 'cbBTC/WETH', 'AERO/USDC'],
  paperBalance: 10000,
  strategies: ['combined'],
  analysisInterval: '15m',
  maxPositionSizePct: 5,
  stopLossPct: 5,
  takeProfitPct: 7,
  maxOpenPositions: 3,
  llmModel: 'nvidia/nemotron-3-nano-30b-a3b:free',
});

const submitting = ref(false);
const validationError = ref('');

/** Extract a short model name from the OpenRouter model ID */
function shortModelName(modelId: string): string {
  // "nvidia/nemotron-3-nano-30b-a3b:free" → "Nemotron"
  const names: Record<string, string> = {
    'nvidia/nemotron-3-nano-30b-a3b:free': 'Nemotron',
    'stepfun/step-3.5-flash:free': 'Step',
    'arcee-ai/trinity-large-preview:free': 'Trinity',
    'liquid/lfm-2.5-1.2b-thinking:free': 'LFM-Think',
    'liquid/lfm-2.5-1.2b-instruct:free': 'LFM',
    'arcee-ai/trinity-mini:free': 'Trinity-Mini',
  };
  return names[modelId] ?? modelId.split('/').pop()?.split(':')[0] ?? 'Agent';
}

/** Generate a name from model + first pair, e.g. "Nemotron · WETH/USDC" */
function generateName(): string {
  const model = shortModelName(form.llmModel ?? 'nvidia/nemotron-3-nano-30b-a3b:free');
  const pairs = form.pairs;
  if (pairs.length === 1 && pairs[0] === '*') return `${model} · All Pairs`;
  const pairLabel = pairs.length === 1 ? pairs[0] : pairs.length > 1 ? `${pairs[0]} +${pairs.length - 1}` : 'Base';
  return `${model} · ${pairLabel}`;
}

// Auto-generate name when model or pairs change (only if user hasn't manually edited)
const nameManuallyEdited = ref(false);
watch([() => form.llmModel, () => [...form.pairs]], () => {
  if (!nameManuallyEdited.value) {
    form.name = generateName();
  }
});
// Set initial generated name
onMounted(() => { form.name = generateName(); });

async function handleSubmit() {
  if (!form.name.trim()) {
    validationError.value = 'Agent name is required';
    return;
  }
  if (!form.pairs.length) {
    validationError.value = 'Select at least one trading pair';
    return;
  }
  validationError.value = '';
  submitting.value = true;

  emit('submit', { ...form });
  submitting.value = false;
}
</script>

<template>
  <form @submit.prevent="handleSubmit">
    <div class="alert alert-error" v-if="validationError">{{ validationError }}</div>

    <div class="form-group">
      <label class="form-label">Agent Name *</label>
      <input v-model="form.name" class="form-input" placeholder="My Alpha Hunter" maxlength="50" required @input="nameManuallyEdited = true" />
    </div>

    <div class="grid-2">
      <div class="form-group">
        <label class="form-label">Autonomy Level</label>
        <select v-model="form.autonomyLevel" class="form-select">
          <option value="full">Full — agent decides everything</option>
          <option value="guided">Guided — within bounds (default)</option>
          <option value="strict">Strict — rule-based only</option>
        </select>
      </div>
      <div class="form-group">
        <label class="form-label">Analysis Interval</label>
        <select v-model="form.analysisInterval" class="form-select">
          <option value="1m">Every 1 minute</option>
          <option value="5m">Every 5 minutes</option>
          <option value="15m">Every 15 minutes (default)</option>
          <option value="1h">Every hour</option>
          <option value="4h">Every 4 hours</option>
          <option value="1d">Daily</option>
        </select>
      </div>
    </div>

    <div class="form-group">
      <label class="form-label">Trading Pairs</label>
      <PairPicker v-model="form.pairs" />
    </div>

    <div class="form-group">
      <label class="form-label">LLM Model</label>
      <select v-model="form.llmModel" class="form-select">
        <option value="nvidia/nemotron-3-nano-30b-a3b:free">Nvidia Nemotron Nano 30B (free)</option>
        <option value="stepfun/step-3.5-flash:free">Step 3.5 Flash (free)</option>
        <option value="arcee-ai/trinity-large-preview:free">Trinity Large Preview (free)</option>
        <option value="liquid/lfm-2.5-1.2b-thinking:free">LFM 2.5 1.2B Thinking (free)</option>
        <option value="liquid/lfm-2.5-1.2b-instruct:free">LFM 2.5 1.2B Instruct (free)</option>
        <option value="arcee-ai/trinity-mini:free">Trinity Mini (free)</option>
      </select>
    </div>

    <div class="grid-2">
      <div class="form-group">
        <label class="form-label">Starting Balance (USDC)</label>
        <input v-model.number="form.paperBalance" type="number" class="form-input" min="100" max="1000000" step="100" />
      </div>
      <div class="form-group">
        <label class="form-label">Max Position Size (%)</label>
        <input v-model.number="form.maxPositionSizePct" type="number" class="form-input" min="1" max="100" />
        <div class="form-hint">Max % of balance per trade</div>
      </div>
    </div>

    <div class="grid-3">
      <div class="form-group">
        <label class="form-label">Stop Loss (%)</label>
        <input v-model.number="form.stopLossPct" type="number" class="form-input" min="0.5" max="50" step="0.5" />
      </div>
      <div class="form-group">
        <label class="form-label">Take Profit (%)</label>
        <input v-model.number="form.takeProfitPct" type="number" class="form-input" min="0.5" max="100" step="0.5" />
      </div>
      <div class="form-group">
        <label class="form-label">Max Open Positions</label>
        <input v-model.number="form.maxOpenPositions" type="number" class="form-input" min="1" max="10" />
      </div>
    </div>

    <div class="form-group">
      <label class="form-label">Strategy</label>
      <select v-model="(form.strategies as string[])[0]" class="form-select">
        <option value="combined">Combined (LLM weighs all indicators)</option>
        <option value="rsi_oversold">RSI Oversold/Overbought</option>
        <option value="ema_crossover">EMA 9/21 Crossover</option>
        <option value="macd_signal">MACD Signal Cross</option>
        <option value="bollinger_bounce">Bollinger Band Bounce</option>
        <option value="llm_sentiment">LLM Sentiment Analysis</option>
      </select>
    </div>

    <div class="modal-footer" style="padding: 0; margin-top: 8px;">
      <button type="button" class="btn btn-ghost" @click="$emit('cancel')">Cancel</button>
      <button type="submit" class="btn btn-primary" :disabled="submitting">
        <span v-if="submitting" class="spinner" style="width:14px;height:14px;"></span>
        Create Agent
      </button>
    </div>
  </form>
</template>
