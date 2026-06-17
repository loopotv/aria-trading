import { describe, it, expect } from "vitest";
import {
  evaluateShortBreakdown,
  checkShortBreakdownConditions,
  R3T25S2,
  type ShortBreakdownFeatures,
} from "../src/trading/strategies/short-breakdown";

/**
 * Synthetic steady 1h downtrend: ~1.5% drop per bar with full-range bars.
 * Guarantees: ema20 < ema50, close < ema20, minusDI > plusDI, high ADX,
 * atrPct ≈ 1.5% (> 1.15% threshold).
 */
function downtrendBars(n = 80, drop = 0.015) {
  const highs: number[] = [];
  const lows: number[] = [];
  const closes: number[] = [];
  let price = 100;
  for (let i = 0; i < n; i++) {
    const prev = price;
    price = prev * (1 - drop);
    highs.push(prev); // opens at prior close, never exceeds it
    lows.push(price);
    closes.push(price);
  }
  return { highs, lows, closes };
}

/** Synthetic steady uptrend (mirror). */
function uptrendBars(n = 80, rise = 0.015) {
  const highs: number[] = [];
  const lows: number[] = [];
  const closes: number[] = [];
  let price = 100;
  for (let i = 0; i < n; i++) {
    const prev = price;
    price = prev * (1 + rise);
    highs.push(price);
    lows.push(prev);
    closes.push(price);
  }
  return { highs, lows, closes };
}

/** Flat, low-volatility series. */
function flatBars(n = 80) {
  const highs: number[] = [];
  const lows: number[] = [];
  const closes: number[] = [];
  for (let i = 0; i < n; i++) {
    const wiggle = i % 2 === 0 ? 0.05 : -0.05;
    highs.push(100.1 + wiggle);
    lows.push(99.9 + wiggle);
    closes.push(100 + wiggle);
  }
  return { highs, lows, closes };
}

describe("evaluateShortBreakdown — end to end on bars", () => {
  it("eligible on a volatile confirmed downtrend with BTC down", () => {
    const { highs, lows, closes } = downtrendBars();
    const r = evaluateShortBreakdown(highs, lows, closes, -0.03);
    expect(r.failed).toEqual([]);
    expect(r.eligible).toBe(true);
    expect(r.atrPct).toBeGreaterThan(R3T25S2.ATR_PCT_MIN);
    expect(r.indicators.ema20).toBeLessThan(r.indicators.ema50);
    expect(r.indicators.minusDI).toBeGreaterThan(r.indicators.plusDI);
    expect(r.indicators.adx).toBeGreaterThan(R3T25S2.ADX_MIN);
  });

  it("NOT eligible when BTC is not down enough (same alt weakness)", () => {
    const { highs, lows, closes } = downtrendBars();
    const r = evaluateShortBreakdown(highs, lows, closes, -0.005);
    expect(r.eligible).toBe(false);
    expect(r.failed).toEqual(["btc_down"]);
  });

  it("NOT eligible on an uptrend even with BTC down (never fade strength)", () => {
    const { highs, lows, closes } = uptrendBars();
    const r = evaluateShortBreakdown(highs, lows, closes, -0.03);
    expect(r.eligible).toBe(false);
    expect(r.failed).toContain("ema_downtrend");
    expect(r.failed).toContain("price_below_ema20");
    expect(r.failed).toContain("di_direction");
  });

  it("NOT eligible on a quiet flat market (no volatility, no trend)", () => {
    const { highs, lows, closes } = flatBars();
    const r = evaluateShortBreakdown(highs, lows, closes, -0.03);
    expect(r.eligible).toBe(false);
    expect(r.failed).toContain("atr_pct");
  });

  it("fail-closed with insufficient data (<51 bars)", () => {
    const { highs, lows, closes } = downtrendBars(50);
    const r = evaluateShortBreakdown(highs, lows, closes, -0.03);
    expect(r.eligible).toBe(false);
    expect(r.failed).toEqual(["insufficient_data"]);
  });

  it("fail-closed with mismatched array lengths", () => {
    const { highs, lows, closes } = downtrendBars();
    const r = evaluateShortBreakdown(highs.slice(1), lows, closes, -0.03);
    expect(r.eligible).toBe(false);
    expect(r.failed).toEqual(["insufficient_data"]);
  });

  it("fail-closed with non-finite btcRet24h", () => {
    const { highs, lows, closes } = downtrendBars();
    const r = evaluateShortBreakdown(highs, lows, closes, NaN);
    expect(r.eligible).toBe(false);
    expect(r.failed).toEqual(["insufficient_data"]);
  });
});

describe("checkShortBreakdownConditions — strict boundaries", () => {
  const passing: ShortBreakdownFeatures = {
    atrPct: 0.02,
    ema20: 95,
    ema50: 98,
    close: 94,
    plusDI: 10,
    minusDI: 25,
    adx: 30,
  };

  it("all conditions true → no failures", () => {
    expect(checkShortBreakdownConditions(passing, -0.03)).toEqual([]);
  });

  it("atrPct exactly at threshold (0.0115) → fails (strict >)", () => {
    expect(
      checkShortBreakdownConditions({ ...passing, atrPct: R3T25S2.ATR_PCT_MIN }, -0.03),
    ).toEqual(["atr_pct"]);
  });

  it("adx exactly at threshold (22) → fails (strict >)", () => {
    expect(
      checkShortBreakdownConditions({ ...passing, adx: R3T25S2.ADX_MIN }, -0.03),
    ).toEqual(["adx_strength"]);
  });

  it("btcRet24h exactly at threshold (-0.025) → fails (strict <)", () => {
    expect(checkShortBreakdownConditions(passing, R3T25S2.BTC_RET_24H_MAX)).toEqual([
      "btc_down",
    ]);
  });

  it("ema20 == ema50 → fails (strict <)", () => {
    expect(
      checkShortBreakdownConditions({ ...passing, ema20: 98, ema50: 98, close: 94 }, -0.03),
    ).toEqual(["ema_downtrend"]);
  });

  it("close == ema20 → fails (strict <)", () => {
    expect(
      checkShortBreakdownConditions({ ...passing, close: 95 }, -0.03),
    ).toEqual(["price_below_ema20"]);
  });

  it("minusDI == plusDI → fails (strict >)", () => {
    expect(
      checkShortBreakdownConditions({ ...passing, plusDI: 20, minusDI: 20 }, -0.03),
    ).toEqual(["di_direction"]);
  });

  it("each condition fails independently with the right label", () => {
    expect(checkShortBreakdownConditions({ ...passing, atrPct: 0.001 }, -0.03)).toEqual([
      "atr_pct",
    ]);
    expect(checkShortBreakdownConditions({ ...passing, adx: 10 }, -0.03)).toEqual([
      "adx_strength",
    ]);
    expect(
      checkShortBreakdownConditions({ ...passing, plusDI: 30 }, -0.03),
    ).toEqual(["di_direction"]);
    expect(checkShortBreakdownConditions(passing, 0.02)).toEqual(["btc_down"]);
  });
});
