<script setup lang="ts">
/**
 * Pair selection modal: searchable, sortable table of top Base pairs by volume.
 * Click a row to select that pair and close the modal.
 */

export interface TopPairRow {
  pairLabel: string;
  pairAddress: string;
  chainId: string;
  dexId: string;
  baseTokenSymbol: string;
  quoteTokenSymbol: string;
  baseTokenAddress: string;
  quoteTokenAddress: string;
  volume24h: number;
  marketCap: number;
  change1d: number | null;
}

const props = defineProps<{
  open: boolean;
}>();

const emit = defineEmits<{
  select: [pairLabel: string];
  close: [];
}>();

const { request } = useApi();

const pairs = ref<TopPairRow[]>([]);
const loading = ref(false);
const error = ref('');
const updatedAt = ref<string | null>(null);
const searchQuery = ref('');

type SortKey = 'pair' | 'volume' | 'marketCap' | 'change1d';
type SortDir = 'asc' | 'desc';
const sortKey = ref<SortKey>('volume');
const sortDir = ref<SortDir>('desc');

function formatUsd(val: number | undefined | null): string {
  if (val == null || val === 0) return '—';
  if (val >= 1_000_000_000) return `$${(val / 1_000_000_000).toFixed(2)}B`;
  if (val >= 1_000_000) return `$${(val / 1_000_000).toFixed(2)}M`;
  if (val >= 1_000) return `$${(val / 1_000).toFixed(1)}K`;
  return `$${val.toFixed(0)}`;
}

function formatPct(val: number | null | undefined): string {
  if (val == null || Number.isNaN(val)) return '—';
  const sign = val >= 0 ? '+' : '';
  return `${sign}${val.toFixed(2)}%`;
}

interface ApiPair {
  baseToken: { symbol: string; address: string };
  quoteToken: { symbol: string; address: string };
  pairAddress: string;
  chainId: string;
  dexId: string;
  volume?: { h24?: number };
  marketCap?: number;
  fdv?: number;
  priceChange?: { h24?: number };
}

function rowToRecord(p: ApiPair): TopPairRow {
  const pairLabel = `${p.baseToken.symbol}/${p.quoteToken.symbol}`;
  return {
    pairLabel,
    pairAddress: p.pairAddress,
    chainId: p.chainId,
    dexId: p.dexId,
    baseTokenSymbol: p.baseToken.symbol,
    quoteTokenSymbol: p.quoteToken.symbol,
    baseTokenAddress: p.baseToken.address,
    quoteTokenAddress: p.quoteToken.address,
    volume24h: p.volume?.h24 ?? 0,
    marketCap: p.marketCap ?? p.fdv ?? 0,
    change1d: p.priceChange?.h24 ?? null,
  };
}

async function fetchTopPairs() {
  loading.value = true;
  error.value = '';
  try {
    const data = await request<{ pairs: unknown[]; updatedAt: string }>(
      '/api/pairs/top?chain=base'
    );
    pairs.value = (data.pairs ?? []).map((p: unknown) => rowToRecord(p as ApiPair));
    updatedAt.value = data.updatedAt ?? null;
  } catch (e) {
    error.value = extractApiError(e);
    pairs.value = [];
  } finally {
    loading.value = false;
  }
}

watch(() => props.open, (isOpen) => {
  if (isOpen) {
    searchQuery.value = '';
    sortKey.value = 'volume';
    sortDir.value = 'desc';
    fetchTopPairs();
  }
});

const filteredPairs = computed(() => {
  let list = [...pairs.value];
  const q = searchQuery.value.trim().toLowerCase();
  if (q) {
    list = list.filter(
      (p) =>
        p.pairLabel.toLowerCase().includes(q)
    );
  }
  list.sort((a, b) => {
    let cmp = 0;
    switch (sortKey.value) {
      case 'pair':
        cmp = a.pairLabel.localeCompare(b.pairLabel);
        break;
      case 'volume':
        cmp = a.volume24h - b.volume24h;
        break;
      case 'marketCap':
        cmp = a.marketCap - b.marketCap;
        break;
      case 'change1d':
        cmp = (a.change1d ?? -Infinity) - (b.change1d ?? -Infinity);
        break;
      default:
        cmp = 0;
    }
    return sortDir.value === 'asc' ? cmp : -cmp;
  });
  return list;
});

function toggleSort(key: SortKey) {
  if (sortKey.value === key) {
    sortDir.value = sortDir.value === 'asc' ? 'desc' : 'asc';
  } else {
    sortKey.value = key;
    sortDir.value = key === 'pair' ? 'asc' : 'desc';
  }
}

function selectPair(pairLabel: string) {
  emit('select', pairLabel);
  emit('close');
}

function formatUpdated() {
  if (!updatedAt.value) return '';
  const d = new Date(updatedAt.value);
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/** Token logo URL (Uniswap assets for Base; fallback shows first letter on error) */
function tokenLogoUrl(chainId: string, address: string): string {
  if (!address) return '';
  const chain = chainId === 'base' ? 'base' : 'ethereum';
  const addr = address.toLowerCase();
  return `https://raw.githubusercontent.com/Uniswap/assets/master/blockchains/${chain}/assets/${addr}/logo.png`;
}
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open"
      class="modal-overlay"
      @click.self="emit('close')"
    >
      <div class="pair-modal modal" @click.stop>
        <div class="modal-header">
          <span class="modal-title">Select trading pair</span>
          <button type="button" class="btn btn-ghost btn-sm" @click="emit('close')">✕</button>
        </div>
        <div class="modal-body pair-modal-body">
          <div class="pair-modal-search">
            <input
              v-model="searchQuery"
              type="text"
              class="form-input"
              placeholder="Filter by pair name or symbol..."
            />
          </div>
          <div v-if="loading" class="pair-modal-loading">
            <span class="spinner" /> Loading pairs…
          </div>
          <div v-else-if="error" class="alert alert-error">{{ error }}</div>
          <div v-else class="pair-table-wrap">
            <table class="pair-table">
              <thead>
                <tr>
                  <th>
                    <button type="button" class="pair-th" @click="toggleSort('pair')">
                      Pair
                      <span v-if="sortKey === 'pair'" class="pair-sort-icon">
                        {{ sortDir === 'asc' ? '↑' : '↓' }}
                      </span>
                    </button>
                  </th>
                  <th>
                    <button type="button" class="pair-th" @click="toggleSort('volume')">
                      Volume
                      <span v-if="sortKey === 'volume'" class="pair-sort-icon">
                        {{ sortDir === 'asc' ? '↑' : '↓' }}
                      </span>
                    </button>
                  </th>
                  <th>
                    <button type="button" class="pair-th" @click="toggleSort('marketCap')">
                      Market Cap
                      <span v-if="sortKey === 'marketCap'" class="pair-sort-icon">
                        {{ sortDir === 'asc' ? '↑' : '↓' }}
                      </span>
                    </button>
                  </th>
                  <th>
                    <button type="button" class="pair-th" @click="toggleSort('change1d')">
                      1D%
                      <span v-if="sortKey === 'change1d'" class="pair-sort-icon">
                        {{ sortDir === 'asc' ? '↑' : '↓' }}
                      </span>
                    </button>
                  </th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="row in filteredPairs"
                  :key="row.pairAddress"
                  class="pair-row"
                  @click="selectPair(row.pairLabel)"
                >
                  <td class="pair-cell pair-name">
                    <div class="pair-name-cell">
                      <span class="pair-tokens">
                        <span class="token-icon-wrap">
                          <img
                            :src="tokenLogoUrl(row.chainId, row.baseTokenAddress)"
                            :alt="row.baseTokenSymbol"
                            class="token-icon"
                            @error="($event.target as HTMLImageElement).style.display = 'none'"
                          >
                          <span v-if="row.baseTokenSymbol" class="token-fallback" aria-hidden="true">{{ row.baseTokenSymbol.slice(0, 1) }}</span>
                        </span>
                        <span class="token-icon-wrap">
                          <img
                            :src="tokenLogoUrl(row.chainId, row.quoteTokenAddress)"
                            :alt="row.quoteTokenSymbol"
                            class="token-icon"
                            @error="($event.target as HTMLImageElement).style.display = 'none'"
                          >
                          <span v-if="row.quoteTokenSymbol" class="token-fallback" aria-hidden="true">{{ row.quoteTokenSymbol.slice(0, 1) }}</span>
                        </span>
                      </span>
                      <span class="pair-label">{{ row.pairLabel }}</span>
                    </div>
                  </td>
                  <td class="pair-cell">{{ formatUsd(row.volume24h) }}</td>
                  <td class="pair-cell">{{ formatUsd(row.marketCap) }}</td>
                  <td
                    class="pair-cell pair-pct"
                    :class="{
                      positive: row.change1d != null && row.change1d >= 0,
                      negative: row.change1d != null && row.change1d < 0,
                    }"
                  >
                    {{ formatPct(row.change1d) }}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
        <div class="pair-modal-footer">
          <span v-if="updatedAt" class="pair-updated">Updated {{ formatUpdated() }}</span>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.pair-modal-body {
  min-height: 280px;
  padding-bottom: 8px;
}
.pair-modal-search {
  margin-bottom: 12px;
}
.pair-modal-search .form-input {
  width: 100%;
}
.pair-modal-loading {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 24px;
  color: var(--text-muted);
  font-size: 13px;
}
.pair-table-wrap {
  overflow-x: auto;
  max-height: 360px;
  overflow-y: auto;
  border: 1px solid var(--border);
  border-radius: var(--radius);
}
.pair-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
.pair-table th,
.pair-table td {
  padding: 10px 12px;
  text-align: left;
  border-bottom: 1px solid var(--border);
}
.pair-table th {
  background: var(--bg-hover);
  color: var(--text-muted);
  font-weight: 600;
  white-space: nowrap;
}
.pair-th {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  background: none;
  border: none;
  color: inherit;
  font: inherit;
  cursor: pointer;
  padding: 0;
}
.pair-th:hover {
  color: var(--text);
}
.pair-sort-icon {
  font-size: 10px;
  opacity: 0.8;
}
.pair-row {
  cursor: pointer;
  transition: background 0.1s;
}
.pair-row:hover {
  background: var(--bg-hover);
}
.pair-cell {
  color: var(--text);
}
.pair-name {
  font-weight: 600;
  font-family: 'JetBrains Mono', monospace;
}

.pair-name-cell {
  display: flex;
  align-items: center;
  gap: 8px;
}

.pair-tokens {
  display: flex;
  align-items: center;
}

.token-icon-wrap {
  position: relative;
  width: 24px;
  height: 24px;
  flex-shrink: 0;
  border-radius: 50%;
  overflow: hidden;
  background: var(--bg-hover);
}

.token-icon-wrap + .token-icon-wrap {
  margin-left: -6px;
}

.token-icon {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  z-index: 1;
}

.token-fallback {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 10px;
  font-weight: 700;
  color: var(--text-muted);
  background: var(--bg-hover);
}

.pair-label {
  font-weight: 600;
  font-family: 'JetBrains Mono', monospace;
}
.pair-pct.positive {
  color: var(--green);
}
.pair-pct.negative {
  color: var(--red);
}
.pair-modal-footer {
  padding: 8px 24px 16px;
  border-top: 1px solid var(--border);
}
.pair-updated {
  font-size: 11px;
  color: var(--text-muted);
}
</style>
