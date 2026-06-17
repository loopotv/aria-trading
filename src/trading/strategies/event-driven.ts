/**
 * Event-Driven Trading Strategy
 *
 * Flow: News event detected → LLM classifies → Quant filter confirms → Trade
 *
 * Key rules (after 2026-05-11 update):
 * 1. Only trade HIGH magnitude events (>0.5)
 * 2. LLM must have HIGH confidence (>0.7)
 * 3. Sentiment direction clear (|score| > 0.3)
 * 4. RSI extreme top/bottom-tick: LONG<72, SHORT>28
 * 4b. RSI+ADX exhaustion: LONG blocked if RSI≥65 AND ADX≥40 (and symmetric
 *     for SHORT) — catches over-extended moves before absolute extremes
 * 5. RSI momentum: SHORT/LONG require RSI≥42
 * 6. Volume gates: SHORT vol≥0.5 (panic-sell), LONG vol≥0.6 (buying pressure)
 * 7. Trade feasibility: ATR%≥0.3 floor + max 4h historical move ≥ 1.2× TP distance
 * 8. Execute within 60 seconds of event detection
 * 9. Tight SL (1.5x ATR), TP 1.8x ATR — realistic for 4h holding
 *
 * Removed gates (telemetry showed 0 effective filtering or full subsumption):
 *   - move_recent (>3%): never triggered in production
 *   - adx_min (≥18): subsumed by RSI momentum + volume gates (0/10 reject in 48h)
 */

import { SentimentSignal } from '../../sentiment/types';
import { STRATEGY_DEFAULTS } from '../strategy-defaults';
import type { FluidParams } from '../fluid-params';
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
  currentPrice: number,
  fluidParams?: FluidParams,
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

  // --- Gate 0: Category allowlist (2026-06-17, Fase 1 verdict) ---
  // Only `event` cleared coin-flip at the 4h horizon (54.1%); announcement /
  // sentiment_aggregate / rumor are noise. Reject the rest up-front.
  if (!STRATEGY_DEFAULTS.allowedCategories.includes(signal.category)) {
    failCheck('category', null, null, `category_${signal.category}_not_allowed`);
    return reject(symbol, `Category '${signal.category}' not traded (only ${STRATEGY_DEFAULTS.allowedCategories.join(',')})`, indicators, checks);
  }
  passCheck('category', null, null);

  // --- Gate 1: Magnitude threshold (Step 1, 2026-05-27: 0.5 → 0.6) ---
  const magMin = STRATEGY_DEFAULTS.magnitudeMin;
  if (signal.magnitude < magMin) {
    failCheck('magnitude', signal.magnitude, magMin, 'magnitude_low');
    return reject(symbol, `Magnitude too low (<${magMin})`, indicators, checks);
  }
  passCheck('magnitude', signal.magnitude, magMin);

  // --- Gate 2: Confidence threshold (Step 1: 0.7 → 0.8) ---
  const confMin = STRATEGY_DEFAULTS.confidenceMin;
  if (signal.confidence < confMin) {
    failCheck('confidence', signal.confidence, confMin, 'confidence_low');
    return reject(symbol, `Confidence too low (<${confMin})`, indicators, checks);
  }
  passCheck('confidence', signal.confidence, confMin);

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

  // --- Gate 4: RSI extreme top-tick / bottom-tick (RE-INTRODUCED 2026-05-08) ---
  // Originally removed 2026-04-27 (0/24 reject at LONG>75/SHORT<25). Brought back
  // with tighter bands after 2 fast-SL losses on 2026-05-06: BNB LONG with RSI 86
  // (-$0.12 in 0.58h) and XRP LONG with RSI 77 (-$0.12 in 0.99h). Both were classic
  // "buy at top" trades — strong trend + extreme RSI = exhausted move, mean-reversion
  // imminent. Soglia 72 LONG avrebbe bloccato entrambi.
  if (direction === 'LONG' && rsi > 72) {
    failCheck('rsi_extreme', rsi, 72, 'rsi_overbought_top_tick');
    return reject(symbol, `LONG blocked: RSI=${rsi.toFixed(0)}>72 (overbought, top-tick risk)`, indicators, checks);
  }
  if (direction === 'SHORT' && rsi < 28) {
    failCheck('rsi_extreme', rsi, 28, 'rsi_oversold_bottom_tick');
    return reject(symbol, `SHORT blocked: RSI=${rsi.toFixed(0)}<28 (oversold, bottom-tick risk)`, indicators, checks);
  }
  passCheck('rsi_extreme', rsi, direction === 'LONG' ? 72 : 28);

  // Gate 4b (rsi_adx_exhaustion) REMOVED 2026-05-28 — hyper-trader doesn't have it,
  // and telemetry shows it was blocking 4 SHORT/day at avg RSI 32 + ADX 41. Those
  // are exactly the kind of trades hyper-trader takes successfully. The gate was
  // added on 2026-05-11 to defend against BNB/XRP/SUI losses, but those are now
  // covered by rsi_extreme (LONG<72, SHORT>28) + top_cap_whitelist + fluidParams.

  // Gate 5 (move_recent) REMOVED 2026-04-27 — 0/65 reject in 24h after lowering to 3%.
  // Avg observed 0.44%, max 1.46%. Even 3% threshold never fires; the gate is dead.
  // If we ever need anti-chasing protection again, pair with sentiment freshness check.

  // --- Gate 6: RSI direction-momentum gate (Step 2, 2026-05-27: now fluid) ---
  // Threshold comes from fluidParams if provided (adapts to asset+regime+ATR
  // historical performance via the patterns table), otherwise falls back to
  // STRATEGY_DEFAULTS.optimalRSI (45 base, but proven losers get +3 and proven
  // winners get -3, clamped to [35, 50]).
  const rsiMomThreshold = fluidParams?.optimalRSI ?? STRATEGY_DEFAULTS.optimalRSI[direction];
  if (direction === 'SHORT' && rsi < rsiMomThreshold) {
    failCheck('rsi_momentum_short', rsi, rsiMomThreshold, 'rsi_too_low_for_short_momentum');
    return reject(symbol, `Anti-bounce: SHORT blocked, RSI=${rsi.toFixed(0)} (need ≥${rsiMomThreshold} fluid)`, indicators, checks);
  }
  if (direction === 'LONG' && rsi < rsiMomThreshold) {
    failCheck('rsi_momentum_long', rsi, rsiMomThreshold, 'rsi_too_low_for_long_momentum');
    return reject(symbol, `Pro-momentum: LONG blocked, RSI=${rsi.toFixed(0)} (need ≥${rsiMomThreshold} fluid)`, indicators, checks);
  }
  passCheck(direction === 'LONG' ? 'rsi_momentum_long' : 'rsi_momentum_short', rsi, rsiMomThreshold);

  // --- Gate 6c: SHORT volume (panic-sell) ---
  if (direction === 'SHORT' && volumeRatio < 0.5) {
    failCheck('vol_short', volumeRatio, 0.5, 'no_panic_sell');
    return reject(symbol, `Anti-bounce: SHORT blocked, vol=${volumeRatio.toFixed(2)}x (no panic-sell)`, indicators, checks);
  }
  if (direction === 'SHORT') passCheck('vol_short', volumeRatio, 0.5);

  // --- Gate 7: LONG buying-pressure with fluid base + time-of-day (Step 1+2, 2026-05-27) ---
  // Base threshold from fluidParams.volumeRatio if available (adapted to pattern
  // history), else STRATEGY_DEFAULTS.volumeRatio.LONG (0.7). Then scaled DOWN
  // in low-volume UTC hours:
  //   0-9 UTC  → ×0.5 (night/Asia)
  //   9-15 UTC → ×0.65 (Europe + US-open overlap)
  //   15-24 UTC → ×1.0 (full US session)
  if (direction === 'LONG') {
    const utcHour = new Date().getUTCHours();
    const todMult = utcHour < 9
      ? STRATEGY_DEFAULTS.todOffPeakNight
      : utcHour < 15
        ? STRATEGY_DEFAULTS.todMidDay
        : 1.0;
    const baseVol = fluidParams?.volumeRatio ?? STRATEGY_DEFAULTS.volumeRatio.LONG;
    const adjustedVolThreshold = baseVol * todMult;
    if (volumeRatio < adjustedVolThreshold) {
      failCheck('vol_long', volumeRatio, adjustedVolThreshold, `no_buying_pressure_tod_${utcHour}h`);
      return reject(symbol, `LONG blocked: vol=${volumeRatio.toFixed(2)}x (need ≥${adjustedVolThreshold.toFixed(2)}, base ${baseVol.toFixed(2)}×${todMult} @${utcHour}h UTC)`, indicators, checks);
    }
    passCheck('vol_long', volumeRatio, adjustedVolThreshold);
  }

  // Gate 8 (adx_min) REMOVED 2026-04-29 — telemetry showed 0/10 reject in 48h.
  // All trades reaching this gate had ADX≥20 (avg 27.6); lower-ADX cases were
  // already filtered by G6 (RSI momentum) and G7 (volume). The gate was subsumed.

  // --- Gate 9 (replaced 2026-04-29): trade_feasibility ---
  // Replaces the old static atr_min gate. Asks the concrete question:
  //   "given this asset's behavior in the last 24h, is the TP at 1.8x ATR
  //    actually reachable within the 4h holding window?"
  //
  // Two checks combined:
  //   (a) Floor: ATR% ≥ 0.3 (anti-zombie absolute minimum)
  //   (b) Reachability: max 4h-window move in last 24h must be ≥ 1.2× the
  //       distance the TP requires (TP = 1.8 × ATR%). I.e. if recent history
  //       shows the asset never coved the required distance in any 4h window,
  //       the TP is statistically unreachable.
  const atrPct = (atr / currentPrice) * 100;
  if (atrPct < 0.3) {
    failCheck('trade_feasibility', atrPct, 0.3, 'atr_floor_zombie_market');
    return reject(symbol, `Asset too quiet (ATR=${atrPct.toFixed(2)}%<0.3% absolute floor)`, indicators, checks);
  }

  const tpDistancePct = 1.8 * atrPct;
  // Compute max absolute % move over any rolling 4h window in the last 24h.
  let max4hMovePct = 0;
  if (closes.length >= 5) {
    const windowSize = 4; // 4 candles = 4h on 1h klines
    const lookback = Math.min(closes.length - windowSize, 24);
    for (let i = closes.length - lookback; i < closes.length; i++) {
      if (i < windowSize) continue;
      const movePct = Math.abs((closes[i] - closes[i - windowSize]) / closes[i - windowSize]) * 100;
      if (movePct > max4hMovePct) max4hMovePct = movePct;
    }
  }
  const reachableScore = tpDistancePct > 0 ? max4hMovePct / tpDistancePct : 0;
  if (reachableScore < 1.2) {
    failCheck('trade_feasibility', reachableScore, 1.2, 'tp_not_historically_reachable');
    return reject(
      symbol,
      `TP not reachable: max 4h move ${max4hMovePct.toFixed(2)}% < ${(tpDistancePct * 1.2).toFixed(2)}% (1.2× TP distance ${tpDistancePct.toFixed(2)}%)`,
      indicators,
      checks,
    );
  }
  passCheck('trade_feasibility', reachableScore, 1.2);

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

  // --- Calculate SL only (2026-06-10: SlowTrail book — no take-profit) ---
  // Aligned with hyper-trader's SlowTrail exit strategy: NO take-profit anywhere.
  // The trail (after 6h, give-back 2% of peak) manages exits with the 48h deadline
  // as ultimate fallback. takeProfit=0 is the sentinel for "no TP".
  const slMultiplier = STRATEGY_DEFAULTS.slAtrMultiplier;

  const stopLoss = direction === 'LONG'
    ? currentPrice - atr * slMultiplier
    : currentPrice + atr * slMultiplier;
  const takeProfit = 0; // SlowTrail sentinel

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
