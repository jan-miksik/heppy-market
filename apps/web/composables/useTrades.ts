/**
 * Trades composable — fetch trade history and stats.
 */
export interface Trade {
  id: string;
  agentId: string;
  pair: string;
  dex: string;
  side: 'buy' | 'sell';
  entryPrice: number;
  exitPrice?: number;
  amountUsd: number;
  pnlPct?: number;
  pnlUsd?: number;
  confidenceBefore: number;
  reasoning: string;
  strategyUsed: string;
  status: 'open' | 'closed' | 'stopped_out';
  openedAt: string;
  closedAt?: string;
}

export interface TradeStats {
  totalTrades: number;
  openTrades: number;
  closedTrades: number;
  winRate: number;
  totalPnlUsd: number;
  avgPnlPct: number;
}

export function useTrades() {
  const { request } = useApi();

  const trades = ref<Trade[]>([]);
  const stats = ref<TradeStats | null>(null);
  const loading = ref(false);
  const error = ref<string | null>(null);

  async function fetchTrades(params?: {
    status?: string;
    limit?: number;
  }) {
    loading.value = true;
    error.value = null;
    try {
      const query = new URLSearchParams();
      if (params?.status) query.set('status', params.status);
      if (params?.limit) query.set('limit', String(params.limit));
      const qs = query.toString() ? `?${query.toString()}` : '';
      const res = await request<{ trades: Trade[] }>(`/api/trades${qs}`);
      trades.value = res.trades;
    } catch (e) {
      error.value = extractApiError(e);
    } finally {
      loading.value = false;
    }
  }

  async function fetchStats() {
    try {
      stats.value = await request<TradeStats>('/api/trades/stats');
    } catch (e) {
      error.value = extractApiError(e);
    }
  }

  async function fetchAgentTrades(agentId: string): Promise<Trade[]> {
    const res = await request<{ trades: Trade[] }>(`/api/agents/${agentId}/trades`);
    return res.trades;
  }

  function formatPnl(pnl?: number): string {
    if (pnl === undefined || pnl === null) return '—';
    const sign = pnl >= 0 ? '+' : '';
    return `${sign}${pnl.toFixed(2)}%`;
  }

  function pnlClass(pnl?: number): string {
    if (pnl === undefined || pnl === null) return 'neutral';
    return pnl >= 0 ? 'positive' : 'negative';
  }

  return {
    trades,
    stats,
    loading,
    error,
    fetchTrades,
    fetchStats,
    fetchAgentTrades,
    formatPnl,
    pnlClass,
  };
}
