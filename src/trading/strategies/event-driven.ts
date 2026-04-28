/**
 * Event-Driven Trading Strategy
 *
 * Flow: News event detected → LLM classifies → Quant filter confirms → Trade
 *
 * Key rules (after mini-Step 2 round 2, 2026-04-27):
 * 1. Only trade HIGH magnitude events (>0.5)
 * 2. LLM must have HIGH confidence (>0.7)
 * 3. Sentiment direction clear (|score| > 0.3)
 * 4. RSI momentum gate: SHORT/LONG require RSI≥42 (lowered from 45 — telemetry
 *    showed 82% reject rate at 45)
 * 5. Volume gates: SHORT vol≥0.5 (panic-sell), LONG vol≥0.7 (buying pressure)
 * 6. Trend confirmation: ADX≥18 — no range markets
 * 7. Volatility gate: ATR%≥0.4% — TP must be reachable in 4h
 * 8. Execute within 60 seconds of event detection
 * 9. Tight SL (1.5x ATR), TP 1.8x ATR — realistic for 4h holding
 *
 * Removed gates (telemetry showed 0 effective filtering):
 *   - rsi_extreme (LONG>75, SHORT<25): subsumed by RSI momentum
 *   - move_recent (>3%, originally >6%): never triggered in production data
 */

import { SentimentSignal } from '../../sentiment/types';
import {
  calculateRSI,
  calculateADX,
  calculateATR,
  calculateVolumeSMA,
  calculateEMA,
} from '../../utils/indicators';

export interface EventTradeSetup {
  approved: boolean;
  reason: string;
  symbol: string;
  direction: 'LONG' | 'SHORT';
  strength: number;
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  atr: number;
  timeoutHours: number; // close after N hours if SL/TP not hit
  indicators: {
    rsi: number;
    adx: number;
    atr: number;
    volumeRatio: number;
  };
  /**
   * Per-gate checks captured during evaluation. Engine writes these to gate_telemetry
   * after the call. First failed gate (passed=false) marks where evaluation stopped.
   * `direction` is captured at the moment of the check (null for pre-direction gates).
   */
  gateChecks: Array<{
    gateId: string;
    direction: 'LONG' | 'SHORT' | null;
    passed: boolean;
    value: number | null;
    threshold: number | null;
    reason: string | null;
  }>;
}

/**
 * Evaluate whether a sentiment signal warrants a trade.
 * This is the "Quant Filter" that confirms the LLM sensor output.
 */
export function evaluateEventSignal(
  signal: SentimentSignal,
  highs: number[],
  lows: number[],
  closes: number[],
  volumes: number[],
  currentPrice: number
): EventTradeSetup {
  const symbol = signal.asset + 'USDT';

  // Indicators (computed up-front so we can attach them to every reject/approve).
  const rsi = calculateRSI(closes);
  const adxRes = calculateADX(highs, lows, closes);
  const atr = calculateATR(highs, lows, closes);
  const avgVol = calculateVolumeSMA(volumes, 20);
  const recentVol = volumes.slice(-3).reduce((a, b) => a + b, 0) / 3;
  const volumeRatio = avgVol > 0 ? recentVol / avgVol : 1;
  const indicators = { rsi, adx: adxRes.adx, atr, volumeRatio };

  const checks: EventTradeSetup['gateChecks'] = [];
  // dirRef: mutable holder so the helpers see the current direction without re-creating closures.
  // Pre-direction gates (G1-G3) log with direction=null; later gates log with the resolved direction.
  const dirRef: { current: 'LONG' | 'SHORT' | null } = { current: null };
  const passCheck = (gateId: string, value: number | null, threshold: number | null) =>
    checks.push({ gateId, direction: dirRef.current, passed: true, value, threshold, reason: null });
  const failCheck = (gateId: string, value: number | null, threshold: number | null, reason: string) =>
    checks.push({ gateId, direction: dirRef.current, passed: false, value, threshold, reason });

  // --- Gate 1: Magnitude threshold ---
  if (signal.magnitude < 0.5) {
    failCheck('magnitude', signal.magnitude, 0.5, 'magnitude_low');
    return reject(symbol, 'Magnitude too low (<0.5)', indicators, checks);
  }
  passCheck('magnitude', signal.magnitude, 0.5);

  // --- Gate 2: Confidence threshold ---
  if (signal.confidence < 0.7) {
    failCheck('confidence', signal.confidence, 0.7, 'confidence_low');
    return reject(symbol, 'Confidence too low (<0.7)', indicators, checks);
  }
  passCheck('confidence', signal.confidence, 0.7);

  // --- Gate 3: Sentiment must have clear direction ---
  const absScore = Math.abs(signal.sentimentScore);
  if (absScore < 0.3) {
    failCheck('sentiment_clear', absScore, 0.3, 'sentiment_neutral');
    return reject(symbol, 'Sentiment too neutral (|score| < 0.3)', indicators, checks);
  }
  passCheck('sentiment_clear', absScore, 0.3);

  const direction: 'LONG' | 'SHORT' =
    signal.sentimentScore > 0 ? 'LONG' : 'SHORT';
  dirRef.current = direction;

  // Gate 4 (rsi_extreme) REMOVED 2026-04-27 — telemetry showed 0/24 reject in 24h.
  // The extreme bands (LONG>75, SHORT<25) are fully subsumed by G6 (rsi_momentum ≥45),
  // which blocks both falling-knife LONG and oversold SHORT in a single check.

  // Gate 5 (move_recent) REMOVED 2026-04-27 — 0/65 reject in 24h after lowering to 3%.
  // Avg observed 0.44%, max 1.46%. Even 3% threshold never fires; the gate is dead.
  // If we ever need anti-chasing protection again, pair with sentiment freshness check.

  // --- Gate 6: RSI direction-momentum gate (Sprint 2A, lowered 45→42 on 2026-04-27) ---
  // Telemetry: 82% reject rate at 45 (avg rejected RSI=37). Lowering to 42 trades off
  // a few more false positives for ~25% more trade flow. Keep monitoring outcomes.
  if (direction === 'SHORT' && rsi < 42) {
    failCheck('rsi_momentum_short', rsi, 42, 'rsi_too_low_for_short_momentum');
    return reject(symbol, `Anti-bounce: SHORT blocked, RSI=${rsi.toFixed(0)} (need ≥42 for clean downtrend)`, indicators, checks);
  }
  if (direction === 'LONG' && rsi < 42) {
    failCheck('rsi_momentum_long', rsi, 42, 'rsi_too_low_for_long_momentum');
    return reject(symbol, `Pro-momentum: LONG blocked, RSI=${rsi.toFixed(0)} (need ≥42 for trend confirmation)`, indicators, checks);
  }
  passCheck(direction === 'LONG' ? 'rsi_momentum_long' : 'rsi_momentum_short', rsi, 42);

  // --- Gate 6c: SHORT volume (panic-sell) ---
  if (direction === 'SHORT' && volumeRatio < 0.5) {
    failCheck('vol_short', volumeRatio, 0.5, 'no_panic_sell');
    return reject(symbol, `Anti-bounce: SHORT blocked, vol=${volumeRatio.toFixed(2)}x (no panic-sell)`, indicators, checks);
  }
  if (direction === 'SHORT') passCheck('vol_short', volumeRatio, 0.5);

  // --- Gate 7: LONG buying-pressure (Sprint 2B) ---
  if (direction === 'LONG' && volumeRatio < 0.7) {
    failCheck('vol_long', volumeRatio, 0.7, 'no_buying_pressure');
    return reject(symbol, `LONG blocked: vol=${volumeRatio.toFixed(2)}x (no buying pressure, need ≥0.7)`, indicators, checks);
  }
  if (direction === 'LONG') passCheck('vol_long', volumeRatio, 0.7);

  // --- Gate 8: ADX minimo — serve un trend confermato (Sprint 2B) ---
  if (adxRes.adx < 18) {
    failCheck('adx_min', adxRes.adx, 18, 'trend_too_weak');
    return reject(symbol, `Trend troppo debole (ADX=${adxRes.adx.toFixed(0)}<18, mercato range)`, indicators, checks);
  }
  passCheck('adx_min', adxRes.adx, 18);

  // --- Gate 9: ATR% minimo — serve volatilità sufficiente per il TP (Sprint 2B) ---
  const atrPct = (atr / currentPrice) * 100;
  if (atrPct < 0.4) {
    failCheck('atr_min', atrPct, 0.4, 'volatility_insufficient');
    return reject(symbol, `Volatilità insufficiente (ATR=${atrPct.toFixed(2)}%<0.4%, TP irraggiungibile in 4h)`, indicators, checks);
  }
  passCheck('atr_min', atrPct, 0.4);

  // --- Gate 10: Trend alignment (bonus, not required) ---
  const ema20 = calculateEMA(closes, 20);
  const lastEma20 = ema20[ema20.length - 1];
  let trendBonus = 0;

  if (direction === 'LONG' && currentPrice > lastEma20 && adxRes.plusDI > adxRes.minusDI) {
    trendBonus = 0.1; // trend alignment bonus
  }
  if (direction === 'SHORT' && currentPrice < lastEma20 && adxRes.minusDI > adxRes.plusDI) {
    trendBonus = 0.1;
  }

  // --- Calculate SL/TP ---
  const slMultiplier = 1.5; // Tight SL for event trades
  const tpMultiplier = 1.8; // Realistic TP — matches 4h holding window (was 2.5x, too ambitious)

  let stopLoss: number;
  let takeProfit: number;

  if (direction === 'LONG') {
    stopLoss = currentPrice - atr * slMultiplier;
    takeProfit = currentPrice + atr * tpMultiplier;
  } else {
    stopLoss = currentPrice + atr * slMultiplier;
    takeProfit = currentPrice - atr * tpMultiplier;
  }

  // Strength combines sentiment + confidence + magnitude + trend
  const strength = Math.min(1,
    Math.abs(signal.sentimentScore) * 0.3 +
    signal.confidence * 0.3 +
    signal.magnitude * 0.3 +
    trendBonus
  );

  return {
    approved: true,
    reason: `Event: ${signal.category}, score=${signal.sentimentScore.toFixed(2)}, ` +
      `conf=${signal.confidence.toFixed(2)}, mag=${signal.magnitude.toFixed(2)}, ` +
      `RSI=${rsi.toFixed(0)}, vol=${volumeRatio.toFixed(1)}x`,
    symbol,
    direction,
    strength,
    entryPrice: currentPrice,
    stopLoss,
    takeProfit,
    atr,
    timeoutHours: 4, // Close after 4 hours if no SL/TP (was 2h — too short for TP to hit)
    indicators,
    gateChecks: checks,
  };
}

function reject(
  symbol: string,
  reason: string,
  indicators: { rsi: number; adx: number; atr: number; volumeRatio: number },
  gateChecks: EventTradeSetup['gateChecks'] = [],
): EventTradeSetup {
  return {
    approved: false,
    reason,
    symbol,
    direction: 'LONG',
    strength: 0,
    entryPrice: 0,
    stopLoss: 0,
    takeProfit: 0,
    atr: 0,
    timeoutHours: 0,
    indicators,
    gateChecks,
  };
}
