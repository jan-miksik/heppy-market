<script setup lang="ts">
import type { CreateAgentPayload } from '~/composables/useAgents';

const emit = defineEmits<{
  submit: [payload: CreateAgentPayload];
  cancel: [];
}>();

const form = reactive<CreateAgentPayload>({
  name: '',
  autonomyLevel: 'guided',
  pairs: ['WETH/USDC', 'cbBTC/WETH', 'AERO/USDC'],
  paperBalance: 10000,
  strategies: ['combined'],
  analysisInterval: '1h',
  maxPositionSizePct: 20,
  stopLossPct: 5,
  takeProfitPct: 10,
  maxOpenPositions: 3,
  llmModel: 'openai/gpt-oss-20b:free',
});

const pairsInput = ref('WETH/USDC, cbBTC/WETH, AERO/USDC');
const submitting = ref(false);
const validationError = ref('');

function parsePairs(str: string): string[] {
  return str
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter((s) => s.length > 0);
}

async function handleSubmit() {
  if (!form.name.trim()) {
    validationError.value = 'Agent name is required';
    return;
  }
  validationError.value = '';
  submitting.value = true;

  const payload = {
    ...form,
    pairs: parsePairs(pairsInput.value),
  };

  emit('submit', payload);
  submitting.value = false;
}
</script>

<template>
  <form @submit.prevent="handleSubmit">
    <div class="alert alert-error" v-if="validationError">{{ validationError }}</div>

    <div class="form-group">
      <label class="form-label">Agent Name *</label>
      <input v-model="form.name" class="form-input" placeholder="My Alpha Hunter" maxlength="50" required />
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
          <option value="15m">Every 15 minutes</option>
          <option value="1h">Every hour (default)</option>
          <option value="4h">Every 4 hours</option>
          <option value="1d">Daily</option>
        </select>
      </div>
    </div>

    <div class="form-group">
      <label class="form-label">Trading Pairs</label>
      <input v-model="pairsInput" class="form-input" placeholder="WETH/USDC, cbBTC/WETH, AERO/USDC" />
      <div class="form-hint">Comma-separated pair names on Base chain</div>
    </div>

    <div class="form-group">
      <label class="form-label">LLM Model</label>
      <select v-model="form.llmModel" class="form-select">
        <option value="openai/gpt-oss-20b:free">OpenAI GPT OSS 20B (free)</option>
        <option value="openai/gpt-oss-120b:free">OpenAI GPT OSS 120B (free)</option>
        <option value="nvidia/nemotron-3-nano-30b-a3b:free">Nvidia Nemotron Nano 30B (free)</option>
        <option value="qwen/qwen3-next-80b-a3b-instruct:free">Qwen3 Next 80B (free)</option>
        <option value="mistralai/mistral-small-3.1-24b-instruct:free">Mistral Small 3.1 24B (free)</option>
        <option value="meta-llama/llama-3.3-70b-instruct:free">Llama 3.3 70B (free)</option>
        <option value="google/gemma-3-27b-it:free">Google Gemma 3 27B (free)</option>
        <option value="anthropic/claude-3.5-sonnet">Claude 3.5 Sonnet (paid)</option>
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
