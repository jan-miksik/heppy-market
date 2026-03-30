/**
 * Agent configuration migration and normalization helpers.
 *
 * Extracted from agent-loop.ts so this logic can be tested independently
 * and reused (e.g. for bulk-migrating configs in a maintenance script).
 *
 * These transforms are applied to raw config JSON from D1 before Zod parsing,
 * and must handle any historical config format produced since launch.
 */

/** Map of legacy analysisInterval string values to current enum values. */
const LEGACY_INTERVAL_MAP: Record<string, string> = {
  '60':    '1h',
  '300':   '1h',
  '900':   '1h',
  '3600':  '1h',
  '14400': '4h',
  '86400': '1d',
};

/** Intervals that have been removed and should be upgraded to the minimum. */
const REMOVED_INTERVALS = new Set(['1m', '5m', '15m']);

/** Valid analysis intervals in the current schema. */
export const VALID_ANALYSIS_INTERVALS = new Set(['1h', '4h', '1d']);

/** Valid strategy values in the current schema. */
export const VALID_STRATEGIES = new Set([
  'ema_crossover',
  'rsi_oversold',
  'macd_signal',
  'bollinger_bounce',
  'volume_breakout',
  'llm_sentiment',
  'combined',
]);

/**
 * Migrate and normalize a raw agent config object before Zod parsing.
 *
 * Handles:
 * - Legacy analysisInterval stored as seconds strings (e.g. "3600" → "1h")
 * - Removed short intervals (1m, 5m, 15m → 1h)
 * - Unknown interval values → "1h" (global default)
 * - Legacy/unknown strategy enum values → "combined"
 * - Out-of-range numeric fields → clamped to schema bounds
 *
 * This function is PURE (no side effects) — it returns a modified copy.
 */
export function migrateAgentConfig(rawConfig: Record<string, unknown>): Record<string, unknown> {
  const config = { ...rawConfig };

  // ── analysisInterval ──────────────────────────────────────────────────────

  if (typeof config.analysisInterval === 'string') {
    // Use a local variable so TypeScript can narrow the type across assignments
    let interval: string = config.analysisInterval;
    // Step 1: Map legacy seconds strings to enum
    if (LEGACY_INTERVAL_MAP[interval]) interval = LEGACY_INTERVAL_MAP[interval];
    // Step 2: Upgrade removed intervals to 1h minimum
    if (REMOVED_INTERVALS.has(interval)) interval = '1h';
    // Step 3: Clamp unknown values to default
    if (!VALID_ANALYSIS_INTERVALS.has(interval)) interval = '1h';
    config.analysisInterval = interval;
  }

  // ── strategies ────────────────────────────────────────────────────────────

  if (Array.isArray(config.strategies)) {
    config.strategies = (config.strategies as string[]).map((s) =>
      VALID_STRATEGIES.has(s) ? s : 'combined'
    );
    if ((config.strategies as string[]).length === 0) {
      config.strategies = ['combined'];
    }
  }

  // ── numeric bounds (clamp to Zod schema limits) ──────────────────────────

  config.stopLossPct        = clampIfNumber(config.stopLossPct,        0.5, 50);
  config.takeProfitPct      = clampIfNumber(config.takeProfitPct,      0.5, 100);
  config.maxPositionSizePct = clampIfNumber(config.maxPositionSizePct, 1,   100);
  config.maxOpenPositions   = roundClampIfNumber(config.maxOpenPositions, 1, 10);
  config.maxDailyLossPct    = clampIfNumber(config.maxDailyLossPct,    1,   50);
  config.paperBalance       = clampIfNumber(config.paperBalance,        100, 1_000_000);
  config.temperature        = clampIfNumber(config.temperature,         0,   2);

  return config;
}

function clampIfNumber(value: unknown, min: number, max: number): unknown {
  if (typeof value !== 'number') return value;
  return Math.min(max, Math.max(min, value));
}

function roundClampIfNumber(value: unknown, min: number, max: number): unknown {
  if (typeof value !== 'number') return value;
  return Math.min(max, Math.max(min, Math.round(value)));
}
