/**
 * Short-breakdown strategy (R3T25S2) — autonomous SHORT sleeve.
 *
 * Validated by the hyper-trader fork as the "short edge" preserved under SlowTrail.
 * Opens SHORT on alts in confirmed downtrend when BTC is also down ≥1%/24h.
 * NO news dependency — pure technical setup on 1h klines.
 *
 * Conditions (ALL strict, evaluated on the latest closed 1h bar):
 *   1. ATR% > 1.15  (excess volatility — the edge lever)
 *   2. EMA20 < EMA50 (medium-term downtrend confirmed)
 *   3. close < EMA20 (price below short-term mean)
 *   4. -DI > +DI (ADX directional indicators agree on bearish)
 *   5. ADX > 22 (trend strength sufficient)
 *   6. BTC 24h return < -1% (macro headwind for the alt sleeve)
 *
 * Pure function, no I/O — unit-tested in tests/short-breakdown.test.ts.
 */

import { calculateEMA, calculateADX, calculateATR } from '../../utils/indicators';

export const R3T25S2 = {
  ATR_PCT_MIN: 0.0115,          // strict >
  ADX_MIN: 22,                   // strict >
  BTC_RET_24H_MAX: -0.01,        // strict <
  KLINE_LIMIT_REQUIRED: 51,      // ≥51 closed bars needed for EMA50
} as const;

export interface ShortBreakdownFeatures {
  atrPct: number;     // decimal (0.02 = 2%)
  ema20: number;
  ema50: number;
  close: number;
  plusDI: number;
  minusDI: number;
  adx: number;
}

export interface ShortBreakdownResult {
  eligible: boolean;
  failed: string[];
  atrPct: number;
  indicators: ShortBreakdownFeatures;
}

/** Strict per-condition check. Returns the list of failed condition labels (empty = eligible). */
export function checkShortBreakdownConditions(
  f: ShortBreakdownFeatures,
  btcRet24h: number,
): string[] {
  const fails: string[] = [];
  if (!(f.atrPct > R3T25S2.ATR_PCT_MIN)) fails.push('atr_pct');
  if (!(f.ema20 < f.ema50)) fails.push('ema_downtrend');
  if (!(f.close < f.ema20)) fails.push('price_below_ema20');
  if (!(f.minusDI > f.plusDI)) fails.push('di_direction');
  if (!(f.adx > R3T25S2.ADX_MIN)) fails.push('adx_strength');
  if (!(btcRet24h < R3T25S2.BTC_RET_24H_MAX)) fails.push('btc_down');
  return fails;
}

/** Full evaluation from raw kline arrays. Fail-closed on insufficient data or NaN inputs. */
export function evaluateShortBreakdown(
  highs: number[],
  lows: number[],
  closes: number[],
  btcRet24h: number,
): ShortBreakdownResult {
  // Fail-closed: insufficient data or non-finite BTC return
  if (
    !Number.isFinite(btcRet24h) ||
    highs.length < R3T25S2.KLINE_LIMIT_REQUIRED ||
    lows.length !== highs.length ||
    closes.length !== highs.length
  ) {
    return {
      eligible: false,
      failed: ['insufficient_data'],
      atrPct: 0,
      indicators: { atrPct: 0, ema20: 0, ema50: 0, close: 0, plusDI: 0, minusDI: 0, adx: 0 },
    };
  }

  const close = closes[closes.length - 1];
  const ema20Arr = calculateEMA(closes, 20);
  const ema50Arr = calculateEMA(closes, 50);
  const ema20 = ema20Arr[ema20Arr.length - 1];
  const ema50 = ema50Arr[ema50Arr.length - 1];
  const atr = calculateATR(highs, lows, closes);
  const atrPct = close > 0 ? atr / close : 0;
  const adxRes = calculateADX(highs, lows, closes);

  const features: ShortBreakdownFeatures = {
    atrPct,
    ema20,
    ema50,
    close,
    plusDI: adxRes.plusDI,
    minusDI: adxRes.minusDI,
    adx: adxRes.adx,
  };

  const failed = checkShortBreakdownConditions(features, btcRet24h);

  return {
    eligible: failed.length === 0,
    failed,
    atrPct,
    indicators: features,
  };
}
