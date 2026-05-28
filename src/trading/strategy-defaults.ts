/**
 * Production Strategy Parameter Defaults — Single Source of Truth.
 *
 * Inspired by hyper-trader fork (mrddter, 2026-05-27) which used this pattern
 * to centralize thresholds. Imported from there as part of Step 1 parameter
 * harmonization on 2026-05-27.
 *
 * All strategy-critical thresholds live here so production, backtest, and
 * tuning all read the same values.
 *
 * Referenced by:
 *   src/trading/strategies/event-driven.ts  (RSI/Vol/SL/TP gates and sizer)
 *   src/trading/engine.ts                    (fearLongBlockComposite, magnitude/confidence pre-filters)
 */

export const STRATEGY_DEFAULTS = {
  // ---- Sensor quality gates (G1-G2) ----
  /** Magnitude minimum for any event-driven trade. */
  magnitudeMin: 0.6,                  // hyper-trader: 0.6 (was 0.5)
  /** Confidence minimum for any event-driven trade. */
  confidenceMin: 0.8,                 // hyper-trader: 0.8 (was 0.7)

  // ---- RSI gates (base, pre-fluid) ----
  /** RSI momentum threshold per direction (base, before fluid adjustment).
   *  Lowered 45→42 on 2026-05-28 — telemetry showed 23 daily reject at 45
   *  vs hyper-trader passing those trades successfully. fluidParams still
   *  raises strict patterns (+3) and lowers proven winners (-3). */
  optimalRSI: { LONG: 42, SHORT: 42 } as const,
  /** Tight extreme bands — LONG blocked above, SHORT blocked below. */
  rsiExtreme: { LONG_MAX: 72, SHORT_MIN: 28 } as const,

  // ---- Volume gates (base, before ToD/fluid) ----
  /** Volume ratio threshold per direction. */
  volumeRatio: { LONG: 0.7, SHORT: 0.5 } as const,

  // ---- ADX trend gate ----
  optimalADX: 20,

  // ---- SL / TP multipliers ----
  /** Stop loss multiplier of ATR. */
  slAtrMultiplier: 1.3,               // hyper-trader: 1.3 (was 1.5 — tighter SL)
  /** Take profit multiplier of ATR. */
  tpAtrMultiplier: 1.5,               // hyper-trader: 1.5 (was 1.8 — more reachable TP)
  /** Default holding timeout hours. */
  timeoutHours: 4,

  // ---- Composite score ----
  /** Composite score minimum for trade approval. */
  compositeMinScore: 65,

  // ---- Fear regime LONG block ----
  /**
   * Fear LONG block: in F&G 26-39 (not EXTREME), LONGs are blocked unless
   * composite ≥ this value. EXTREME_FEAR (F&G≤25) handled by regime sizing.
   * Replaces the old binary fg_long_block (≤45 = reject all) — that paralyzed
   * the system in persistent Fear. The smarter version lets through only
   * setups with strong multi-factor agreement.
   */
  fearLongBlockComposite: 85,

  // ---- Time-of-day volume multiplier ----
  /** Off-peak volume multiplier (UTC 0-9h, Asia/Europe early morning). */
  todOffPeakNight: 0.5,
  /** Mid-day volume multiplier (UTC 9-15h, Europe/US open overlap). */
  todMidDay: 0.65,

  // ---- Macro regime ----
  /** RISK_OFF activation: BTC 24h% threshold (when F&G < 40 also). */
  riskOffBtcThreshold: -1.5,

  // ---- Fluid params guardrails ----
  /** RSI threshold clamp. */
  fluidRsiClamp: { min: 35, max: 50 } as const,
  /** Volume ratio clamp. */
  fluidVolClamp: { min: 0.4, max: 1.5 } as const,
  /** Default fluid ticks. */
  fluidTicksDefault: 2,
} as const;
