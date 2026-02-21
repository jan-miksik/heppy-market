<script setup lang="ts">
const props = defineProps<{
  modelValue: string[];
}>();

const emit = defineEmits<{
  'update:modelValue': [pairs: string[]];
}>();

const { request } = useApi();

const query = ref('');
const results = ref<Array<{
  pairLabel: string;
  dex: string;
  liquidity: string;
  volume24h: string;
  pairAddress: string;
}>>([]);
const searching = ref(false);
const showDropdown = ref(false);
const allPairs = ref(false);

const POPULAR_PAIRS = [
  'WETH/USDC',
  'cbBTC/WETH',
  'AERO/USDC',
  'DEGEN/WETH',
  'BRETT/WETH',
  'TOSHI/WETH',
  'USDbC/USDC',
];

let debounceTimer: ReturnType<typeof setTimeout> | null = null;

function formatUsd(val: number | undefined): string {
  if (!val || val === 0) return '$0';
  if (val >= 1_000_000) return `$${(val / 1_000_000).toFixed(1)}M`;
  if (val >= 1_000) return `$${(val / 1_000).toFixed(0)}K`;
  return `$${val.toFixed(0)}`;
}

async function searchPairs(q: string) {
  if (!q.trim()) {
    results.value = [];
    return;
  }
  searching.value = true;
  try {
    const data = await request<{ pairs: Array<{
      baseToken: { symbol: string };
      quoteToken: { symbol: string };
      dexId: string;
      liquidity: { usd: number };
      volume: { h24: number };
      pairAddress: string;
    }> }>(`/api/pairs/search?q=${encodeURIComponent(q)}`);
    const pairs = data.pairs ?? [];
    // Deduplicate by pair label, keep highest liquidity
    const seen = new Map<string, typeof results.value[0]>();
    for (const p of pairs) {
      const label = `${p.baseToken.symbol}/${p.quoteToken.symbol}`;
      const existing = seen.get(label);
      const liq = p.liquidity?.usd ?? 0;
      if (!existing || parseFloat(existing.liquidity.replace(/[$MK,]/g, '')) < liq) {
        seen.set(label, {
          pairLabel: label,
          dex: p.dexId ?? 'unknown',
          liquidity: formatUsd(liq),
          volume24h: formatUsd(p.volume?.h24),
          pairAddress: p.pairAddress,
        });
      }
    }
    results.value = Array.from(seen.values()).slice(0, 12);
  } catch {
    results.value = [];
  } finally {
    searching.value = false;
  }
}

function onInput() {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    searchPairs(query.value);
    showDropdown.value = true;
  }, 300);
}

function selectPair(label: string) {
  if (!props.modelValue.includes(label)) {
    emit('update:modelValue', [...props.modelValue, label]);
  }
  query.value = '';
  results.value = [];
  showDropdown.value = false;
}

function removePair(label: string) {
  emit('update:modelValue', props.modelValue.filter(p => p !== label));
}

function toggleAllPairs() {
  allPairs.value = !allPairs.value;
  if (allPairs.value) {
    emit('update:modelValue', ['*']);
  } else {
    emit('update:modelValue', ['WETH/USDC', 'cbBTC/WETH', 'AERO/USDC']);
  }
}

function addPopular(label: string) {
  if (!props.modelValue.includes(label)) {
    emit('update:modelValue', [...props.modelValue, label]);
  }
}

// Close dropdown on outside click
const pickerRef = ref<HTMLElement | null>(null);
function onClickOutside(e: MouseEvent) {
  if (pickerRef.value && !pickerRef.value.contains(e.target as Node)) {
    showDropdown.value = false;
  }
}
onMounted(() => document.addEventListener('click', onClickOutside));
onUnmounted(() => document.removeEventListener('click', onClickOutside));

const isAllPairs = computed(() => props.modelValue.length === 1 && props.modelValue[0] === '*');
</script>

<template>
  <div class="pair-picker" ref="pickerRef">
    <!-- All Pairs toggle -->
    <label class="all-pairs-toggle" @click.prevent="toggleAllPairs">
      <span class="toggle-track" :class="{ active: isAllPairs }">
        <span class="toggle-thumb" />
      </span>
      <span class="toggle-label">All Base pairs</span>
    </label>

    <template v-if="!isAllPairs">
      <!-- Search input -->
      <div class="pair-search-wrap">
        <input
          v-model="query"
          class="form-input"
          placeholder="Search pairs (e.g. WETH, DEGEN)..."
          @input="onInput"
          @focus="showDropdown = true"
        />
        <span v-if="searching" class="spinner pair-spinner" />
      </div>

      <!-- Dropdown results -->
      <div v-if="showDropdown && results.length > 0" class="pair-dropdown">
        <div
          v-for="r in results"
          :key="r.pairAddress"
          class="pair-result"
          @mousedown.prevent="selectPair(r.pairLabel)"
        >
          <span class="pair-result-label">{{ r.pairLabel }}</span>
          <span class="pair-result-meta">
            <span class="pair-result-dex">{{ r.dex }}</span>
            <span class="pair-result-liq">{{ r.liquidity }} liq</span>
            <span class="pair-result-vol">{{ r.volume24h }} vol</span>
          </span>
        </div>
      </div>

      <!-- Selected chips -->
      <div v-if="modelValue.length > 0" class="pair-chips">
        <span
          v-for="pair in modelValue"
          :key="pair"
          class="pair-chip"
        >
          {{ pair }}
          <button class="pair-chip-remove" @click="removePair(pair)" type="button">&times;</button>
        </span>
      </div>

      <!-- Popular presets -->
      <div class="pair-popular">
        <span class="pair-popular-label">Popular:</span>
        <button
          v-for="p in POPULAR_PAIRS"
          :key="p"
          type="button"
          class="pair-popular-btn"
          :class="{ selected: modelValue.includes(p) }"
          @click="modelValue.includes(p) ? removePair(p) : addPopular(p)"
        >
          {{ p }}
        </button>
      </div>
    </template>

    <div v-else class="all-pairs-hint">
      Agent will monitor all available Base chain pairs
    </div>
  </div>
</template>

<style scoped>
.pair-picker {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.all-pairs-toggle {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  user-select: none;
  margin-bottom: 2px;
}
.toggle-track {
  width: 32px;
  height: 18px;
  background: var(--border-light);
  border-radius: 9px;
  position: relative;
  transition: background 0.2s;
}
.toggle-track.active {
  background: var(--accent);
}
.toggle-thumb {
  width: 14px;
  height: 14px;
  background: var(--text);
  border-radius: 50%;
  position: absolute;
  top: 2px;
  left: 2px;
  transition: transform 0.2s;
}
.toggle-track.active .toggle-thumb {
  transform: translateX(14px);
}
.toggle-label {
  font-size: 12px;
  color: var(--text-dim);
  font-weight: 500;
}

.pair-search-wrap {
  position: relative;
}
.pair-spinner {
  position: absolute;
  right: 10px;
  top: 50%;
  transform: translateY(-50%);
  width: 14px;
  height: 14px;
}

.pair-dropdown {
  background: var(--bg);
  border: 1px solid var(--border-light);
  border-radius: var(--radius);
  max-height: 200px;
  overflow-y: auto;
  z-index: 10;
}
.pair-result {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  cursor: pointer;
  transition: background 0.1s;
}
.pair-result:hover {
  background: var(--bg-hover);
}
.pair-result-label {
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
}
.pair-result-meta {
  display: flex;
  gap: 10px;
  font-size: 11px;
  color: var(--text-muted);
}
.pair-result-dex {
  color: var(--accent);
}

.pair-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.pair-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  background: var(--accent-dim);
  color: var(--accent);
  padding: 3px 10px;
  border-radius: 20px;
  font-size: 12px;
  font-weight: 600;
}
.pair-chip-remove {
  background: none;
  border: none;
  color: var(--accent);
  cursor: pointer;
  font-size: 15px;
  line-height: 1;
  padding: 0 0 0 2px;
  opacity: 0.6;
  transition: opacity 0.15s;
}
.pair-chip-remove:hover {
  opacity: 1;
}

.pair-popular {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 5px;
}
.pair-popular-label {
  font-size: 11px;
  color: var(--text-muted);
  font-weight: 500;
}
.pair-popular-btn {
  background: var(--bg);
  border: 1px solid var(--border);
  color: var(--text-dim);
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 11px;
  cursor: pointer;
  font-family: inherit;
  transition: all 0.15s;
}
.pair-popular-btn:hover {
  border-color: var(--border-light);
  color: var(--text);
}
.pair-popular-btn.selected {
  background: var(--accent-dim);
  border-color: var(--accent);
  color: var(--accent);
}

.all-pairs-hint {
  font-size: 12px;
  color: var(--text-muted);
  font-style: italic;
}
</style>
