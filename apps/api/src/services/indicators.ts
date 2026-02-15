/**
 * Technical indicators wrapper.
 * Uses the `technicalindicators` npm package — pure JS, works on CF Workers.
 */
import {
  RSI,
  EMA,
  MACD,
  BollingerBands,
  SMA,
} from 'technicalindicators';

export interface IndicatorResult {
  rsi?: number[];
  ema9?: number[];
  ema21?: number[];
  macd?: MACDResult[];
  bollingerBands?: BollingerResult[];
  sma20?: number[];
}

export interface MACDResult {
  MACD?: number;
  signal?: number;
  histogram?: number;
}

export interface BollingerResult {
  middle: number;
  upper: number;
  lower: number;
  pb?: number; // percent bandwidth
}

export interface SignalResult {
  strategy: string;
  signal: 'buy' | 'sell' | 'hold';
  confidence: number;
  reason: string;
}

/**
 * Compute all configured indicators from a price series.
 * Requires at least 26 prices for MACD; fewer returns partial results.
 */
export function computeIndicators(prices: number[]): IndicatorResult {
  if (prices.length < 2) {
    return {};
  }

  const result: IndicatorResult = {};

  // RSI (period 14 — needs 15+ prices)
  if (prices.length >= 15) {
    result.rsi = RSI.calculate({ period: 14, values: prices });
  }

  // EMA 9 and 21
  if (prices.length >= 9) {
    result.ema9 = EMA.calculate({ period: 9, values: prices });
  }
  if (prices.length >= 21) {
    result.ema21 = EMA.calculate({ period: 21, values: prices });
  }

  // MACD (12, 26, 9)
  if (prices.length >= 26) {
    result.macd = MACD.calculate({
      fastPeriod: 12,
      slowPeriod: 26,
      signalPeriod: 9,
      SimpleMAOscillator: false,
      SimpleMASignal: false,
      values: prices,
    });
  }

  // Bollinger Bands (period 20, stdDev 2)
  if (prices.length >= 20) {
    result.bollingerBands = BollingerBands.calculate({
      period: 20,
      stdDev: 2,
      values: prices,
    });
  }

  // SMA 20
  if (prices.length >= 20) {
    result.sma20 = SMA.calculate({ period: 20, values: prices });
  }

  return result;
}

/** Get the latest value from an array (or undefined if empty) */
function latest<T>(arr: T[] | undefined): T | undefined {
  return arr && arr.length > 0 ? arr[arr.length - 1] : undefined;
}

/**
 * Evaluate signals from computed indicators.
 * Returns one signal per strategy.
 */
export function evaluateSignals(
  indicators: IndicatorResult,
  currentPrice: number
): SignalResult[] {
  const signals: SignalResult[] = [];

  // RSI oversold / overbought
  const rsi = latest(indicators.rsi);
  if (rsi !== undefined) {
    if (rsi < 30) {
      signals.push({
        strategy: 'rsi_oversold',
        signal: 'buy',
        confidence: Math.min(0.9, (30 - rsi) / 30 + 0.5),
        reason: `RSI ${rsi.toFixed(1)} below 30 — oversold`,
      });
    } else if (rsi > 70) {
      signals.push({
        strategy: 'rsi_oversold',
        signal: 'sell',
        confidence: Math.min(0.9, (rsi - 70) / 30 + 0.5),
        reason: `RSI ${rsi.toFixed(1)} above 70 — overbought`,
      });
    } else {
      signals.push({
        strategy: 'rsi_oversold',
        signal: 'hold',
        confidence: 0.6,
        reason: `RSI ${rsi.toFixed(1)} in neutral zone (30-70)`,
      });
    }
  }

  // EMA crossover (9 / 21)
  const ema9 = latest(indicators.ema9);
  const ema21 = latest(indicators.ema21);
  if (ema9 !== undefined && ema21 !== undefined) {
    const prevEma9 =
      indicators.ema9 && indicators.ema9.length >= 2
        ? indicators.ema9[indicators.ema9.length - 2]
        : undefined;
    const prevEma21 =
      indicators.ema21 && indicators.ema21.length >= 2
        ? indicators.ema21[indicators.ema21.length - 2]
        : undefined;

    if (prevEma9 !== undefined && prevEma21 !== undefined) {
      const crossedAbove = prevEma9 <= prevEma21 && ema9 > ema21;
      const crossedBelow = prevEma9 >= prevEma21 && ema9 < ema21;

      if (crossedAbove) {
        signals.push({
          strategy: 'ema_crossover',
          signal: 'buy',
          confidence: 0.75,
          reason: `EMA9 crossed above EMA21 (${ema9.toFixed(4)} > ${ema21.toFixed(4)})`,
        });
      } else if (crossedBelow) {
        signals.push({
          strategy: 'ema_crossover',
          signal: 'sell',
          confidence: 0.75,
          reason: `EMA9 crossed below EMA21 (${ema9.toFixed(4)} < ${ema21.toFixed(4)})`,
        });
      } else {
        signals.push({
          strategy: 'ema_crossover',
          signal: 'hold',
          confidence: 0.5,
          reason: `No EMA crossover — EMA9=${ema9.toFixed(4)}, EMA21=${ema21.toFixed(4)}`,
        });
      }
    }
  }

  // MACD signal line cross
  const macdData = latest(indicators.macd);
  if (macdData?.MACD !== undefined && macdData?.signal !== undefined) {
    const histogram = macdData.MACD - macdData.signal;
    const prevMacd = indicators.macd && indicators.macd.length >= 2
      ? indicators.macd[indicators.macd.length - 2]
      : undefined;

    if (prevMacd?.MACD !== undefined && prevMacd?.signal !== undefined) {
      const prevHistogram = prevMacd.MACD - prevMacd.signal;

      if (prevHistogram < 0 && histogram > 0) {
        signals.push({
          strategy: 'macd_signal',
          signal: 'buy',
          confidence: 0.7,
          reason: `MACD crossed above signal line (histogram: ${histogram.toFixed(6)})`,
        });
      } else if (prevHistogram > 0 && histogram < 0) {
        signals.push({
          strategy: 'macd_signal',
          signal: 'sell',
          confidence: 0.7,
          reason: `MACD crossed below signal line (histogram: ${histogram.toFixed(6)})`,
        });
      } else {
        signals.push({
          strategy: 'macd_signal',
          signal: 'hold',
          confidence: 0.5,
          reason: `No MACD signal cross (histogram: ${histogram.toFixed(6)})`,
        });
      }
    }
  }

  // Bollinger Band bounce
  const bb = latest(indicators.bollingerBands);
  if (bb !== undefined) {
    const bandWidth = bb.upper - bb.lower;
    if (bandWidth > 0) {
      const pbValue = (currentPrice - bb.lower) / bandWidth;

      if (pbValue < 0.05) {
        signals.push({
          strategy: 'bollinger_bounce',
          signal: 'buy',
          confidence: 0.72,
          reason: `Price near lower Bollinger Band (${pbValue.toFixed(3)} %B)`,
        });
      } else if (pbValue > 0.95) {
        signals.push({
          strategy: 'bollinger_bounce',
          signal: 'sell',
          confidence: 0.72,
          reason: `Price near upper Bollinger Band (${pbValue.toFixed(3)} %B)`,
        });
      } else {
        signals.push({
          strategy: 'bollinger_bounce',
          signal: 'hold',
          confidence: 0.5,
          reason: `Price in middle of Bollinger Bands (%B=${pbValue.toFixed(3)})`,
        });
      }
    }
  }

  return signals;
}

/** Aggregate multiple signals into a single combined signal */
export function combineSignals(signals: SignalResult[]): SignalResult {
  if (signals.length === 0) {
    return {
      strategy: 'combined',
      signal: 'hold',
      confidence: 0.5,
      reason: 'No signals available',
    };
  }

  const buySignals = signals.filter((s) => s.signal === 'buy');
  const sellSignals = signals.filter((s) => s.signal === 'sell');

  const buyScore = buySignals.reduce((acc, s) => acc + s.confidence, 0);
  const sellScore = sellSignals.reduce((acc, s) => acc + s.confidence, 0);

  if (buyScore > sellScore && buyScore > 1.0) {
    const avgConf = buyScore / buySignals.length;
    return {
      strategy: 'combined',
      signal: 'buy',
      confidence: Math.min(0.95, avgConf),
      reason: `${buySignals.length}/${signals.length} indicators bullish. ${buySignals.map((s) => s.reason).join('; ')}`,
    };
  }

  if (sellScore > buyScore && sellScore > 1.0) {
    const avgConf = sellScore / sellSignals.length;
    return {
      strategy: 'combined',
      signal: 'sell',
      confidence: Math.min(0.95, avgConf),
      reason: `${sellSignals.length}/${signals.length} indicators bearish. ${sellSignals.map((s) => s.reason).join('; ')}`,
    };
  }

  return {
    strategy: 'combined',
    signal: 'hold',
    confidence: 0.5,
    reason: `Mixed signals — buy score: ${buyScore.toFixed(2)}, sell score: ${sellScore.toFixed(2)}`,
  };
}
