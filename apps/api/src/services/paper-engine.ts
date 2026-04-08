import { generateId, nowIso } from '../lib/utils.js';
import type { PerpPositionState } from '../agents/perp-state-machine.js';

export interface Position {
  id: string;
  agentId: string;
  pair: string;
  dex: string;
  side: 'buy' | 'sell';
  entryPrice: number;
  effectiveEntryPrice: number; // after slippage
  amountUsd: number;
  tokenAmount: number; // how many tokens bought
  confidenceBefore: number;
  reasoning: string;
  strategyUsed: string;
  slippageSimulated: number;
  status: 'open' | 'closed';
  closeReason?: 'stop_loss' | 'take_profit' | 'manual' | 'llm_decision';
  openedAt: string;
  closedAt?: string;
  exitPrice?: number;
  effectiveExitPrice?: number;
  pnlPct?: number;
  pnlUsd?: number;
  confidenceAfter?: number;
}

export interface OpenPositionParams {
  agentId: string;
  pair: string;
  dex: string;
  side: 'buy' | 'sell';
  price: number;
  amountUsd: number;
  maxPositionSizePct: number;
  balance: number;
  confidence: number;
  reasoning: string;
  strategyUsed: string;
  slippagePct?: number;
}

export interface ClosePositionParams {
  price: number;
  confidence?: number;
  reason?: string;
  closeReason?: 'stop_loss' | 'take_profit' | 'manual' | 'llm_decision';
}

export interface PaperEngineState {
  balance: number;
  initialBalance: number;
  openPositions: Map<string, Position>;
  closedPositions: Position[];
  dailyStartBalance: number;
  lastDailyReset: string;
}

export class PaperEngine {
  private state: PaperEngineState;
  private slippagePct: number;
  private mode: 'long-short' | 'spot-only';

  constructor(params: { balance: number; slippage: number; mode?: 'long-short' | 'spot-only' }) {
    this.slippagePct = params.slippage / 100; // convert 0.3% → 0.003
    this.mode = params.mode ?? 'long-short';
    this.state = {
      balance: params.balance,
      initialBalance: params.balance,
      openPositions: new Map(),
      closedPositions: [],
      dailyStartBalance: params.balance,
      lastDailyReset: nowIso().slice(0, 10),
    };
  }

  get balance(): number {
    return this.state.balance;
  }

  get openPositions(): Position[] {
    return Array.from(this.state.openPositions.values());
  }

  get closedPositions(): Position[] {
    return this.state.closedPositions;
  }

  /** Returns LONG, SHORT or FLAT based on open positions. */
  getCurrentPositionState(pair: string): PerpPositionState {
    const openBuy = Array.from(this.state.openPositions.values()).find(
      (p) => p.pair === pair && p.side === 'buy',
    );
    const openSell = Array.from(this.state.openPositions.values()).find(
      (p) => p.pair === pair && p.side === 'sell',
    );
    return openBuy ? 'LONG' : openSell ? 'SHORT' : 'FLAT';
  }

  /** Open a new paper position. Throws if constraints are violated. */
  openPosition(params: OpenPositionParams): Position {
    if (this.mode === 'spot-only' && params.side === 'sell') {
      throw new Error('spot-only mode: short positions are not allowed');
    }

    if (params.amountUsd > this.state.balance) {
      throw new Error(
        `Insufficient balance: $${this.state.balance.toFixed(2)} < $${params.amountUsd.toFixed(2)}`
      );
    }

    const maxAllowed =
      (this.state.balance * params.maxPositionSizePct) / 100;

    if (params.amountUsd > maxAllowed) {
      throw new Error(
        `Position size $${params.amountUsd.toFixed(2)} exceeds max allowed ` +
          `$${maxAllowed.toFixed(2)} (${params.maxPositionSizePct}% of $${this.state.balance.toFixed(2)} balance)`
      );
    }

    if (params.amountUsd <= 0) {
      throw new Error('Position amount must be positive');
    }

    // Apply slippage (buy at slightly higher price, sell at slightly lower)
    const slippage = params.slippagePct !== undefined
      ? params.slippagePct / 100
      : this.slippagePct;

    const effectiveEntryPrice =
      params.side === 'buy'
        ? params.price * (1 + slippage)
        : params.price * (1 - slippage);

    const tokenAmount = params.amountUsd / effectiveEntryPrice;

    const position: Position = {
      id: generateId('pos'),
      agentId: params.agentId,
      pair: params.pair,
      dex: params.dex,
      side: params.side,
      entryPrice: params.price,
      effectiveEntryPrice,
      amountUsd: params.amountUsd,
      tokenAmount,
      confidenceBefore: params.confidence,
      reasoning: params.reasoning,
      strategyUsed: params.strategyUsed,
      slippageSimulated: slippage,
      status: 'open',
      openedAt: nowIso(),
    };

    // Deduct from balance
    this.state.balance -= params.amountUsd;
    this.state.openPositions.set(position.id, position);

    return position;
  }

  /** Close an open position and calculate P&L. */
  closePosition(
    positionId: string,
    params: ClosePositionParams
  ): Position {
    const position = this.state.openPositions.get(positionId);
    if (!position) {
      throw new Error(`Position ${positionId} not found or already closed`);
    }

    // Apply slippage on exit (inverse of entry)
    const effectiveExitPrice =
      position.side === 'buy'
        ? params.price * (1 - position.slippageSimulated)
        : params.price * (1 + position.slippageSimulated);

    // P&L calculation
    let pnlPct: number;
    let proceedsUsd: number;

    if (position.side === 'buy') {
      // Bought tokens, now selling
      proceedsUsd = position.tokenAmount * effectiveExitPrice;
      pnlPct =
        ((effectiveExitPrice - position.effectiveEntryPrice) /
          position.effectiveEntryPrice) *
        100;
    } else {
      // Shorted (sold), now buying back
      const buyBackCost = position.tokenAmount * effectiveExitPrice;
      proceedsUsd = position.amountUsd * 2 - buyBackCost;
      pnlPct =
        ((position.effectiveEntryPrice - effectiveExitPrice) /
          position.effectiveEntryPrice) *
        100;
    }

    const pnlUsd = proceedsUsd - position.amountUsd;

    const closed: Position = {
      ...position,
      status: 'closed',
      closeReason: params.closeReason,
      exitPrice: params.price,
      effectiveExitPrice,
      pnlPct,
      pnlUsd,
      confidenceAfter: params.confidence,
      closedAt: nowIso(),
    };

    // Return proceeds to balance
    this.state.balance += proceedsUsd;
    this.state.openPositions.delete(positionId);
    this.state.closedPositions.push(closed);

    return closed;
  }

  /** Stop out a position (closes with stop_loss reason) */
  stopOutPosition(positionId: string, price: number): Position {
    return this.closePosition(positionId, { price, closeReason: 'stop_loss' });
  }

  /** Effective (slippage-adjusted) exit price if we closed now at `marketPrice`. */
  private effectiveExitPrice(position: Position, marketPrice: number): number {
    // Apply slippage on exit (inverse of entry)
    return position.side === 'buy'
      ? marketPrice * (1 - position.slippageSimulated)
      : marketPrice * (1 + position.slippageSimulated);
  }

  /** Check if a position should be stopped out */
  checkStopLoss(
    position: Position,
    currentPrice: number,
    stopLossPct: number
  ): boolean {
    const threshold = stopLossPct / 100;
    const effectiveExit = this.effectiveExitPrice(position, currentPrice);
    if (position.side === 'buy') {
      const loss =
        (position.effectiveEntryPrice - effectiveExit) /
        position.effectiveEntryPrice;
      return loss >= threshold;
    } else {
      const loss =
        (effectiveExit - position.effectiveEntryPrice) /
        position.effectiveEntryPrice;
      return loss >= threshold;
    }
  }

  /** Check if a position should take profit */
  checkTakeProfit(
    position: Position,
    currentPrice: number,
    takeProfitPct: number
  ): boolean {
    const threshold = takeProfitPct / 100;
    const effectiveExit = this.effectiveExitPrice(position, currentPrice);
    if (position.side === 'buy') {
      const gain =
        (effectiveExit - position.effectiveEntryPrice) /
        position.effectiveEntryPrice;
      return gain >= threshold;
    } else {
      const gain =
        (position.effectiveEntryPrice - effectiveExit) /
        position.effectiveEntryPrice;
      return gain >= threshold;
    }
  }

  /** Calculate daily P&L percentage */
  getDailyPnlPct(): number {
    const today = nowIso().slice(0, 10);
    if (today !== this.state.lastDailyReset) {
      this.state.dailyStartBalance = this.state.balance;
      this.state.lastDailyReset = today;
    }
    return (
      ((this.state.balance - this.state.dailyStartBalance) /
        this.state.dailyStartBalance) *
      100
    );
  }

  /** Calculate total P&L percentage from initial balance */
  getTotalPnlPct(): number {
    return (
      ((this.state.balance - this.state.initialBalance) /
        this.state.initialBalance) *
      100
    );
  }

  /** Get win rate from closed positions */
  getWinRate(): number {
    const closed = this.state.closedPositions;
    if (closed.length === 0) return 0;
    const wins = closed.filter((p) => (p.pnlPct ?? 0) > 0).length;
    return wins / closed.length;
  }

  /** Serialize engine state to plain object for DO storage */
  serialize(): {
    balance: number;
    initialBalance: number;
    positions: Position[];
    closedPositions: Position[];
    dailyStartBalance: number;
    lastDailyReset: string;
    slippagePct: number;
    mode: 'long-short' | 'spot-only';
  } {
    return {
      balance: this.state.balance,
      initialBalance: this.state.initialBalance,
      positions: Array.from(this.state.openPositions.values()),
      closedPositions: this.state.closedPositions,
      dailyStartBalance: this.state.dailyStartBalance,
      lastDailyReset: this.state.lastDailyReset,
      slippagePct: this.slippagePct * 100,
      mode: this.mode,
    };
  }

  /** Restore engine from serialized state */
  static deserialize(data: ReturnType<PaperEngine['serialize']>): PaperEngine {
    const engine = new PaperEngine({
      balance: data.balance,
      slippage: data.slippagePct,
      mode: data.mode,
    });
    engine.state.initialBalance = data.initialBalance;
    engine.state.dailyStartBalance = data.dailyStartBalance;
    engine.state.lastDailyReset = data.lastDailyReset;
    engine.state.closedPositions = data.closedPositions;
    for (const pos of data.positions) {
      engine.state.openPositions.set(pos.id, pos);
    }
    return engine;
  }
}
