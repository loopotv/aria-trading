/**
 * Tests for the trade_feasibility logic that replaced the old static atr_min gate.
 *
 * Pure-math reproduction (the production gate is intertwined with the rest of
 * evaluateEventSignal; here we test only the reachability calculation).
 */

import { describe, it, expect } from 'vitest';

function maxRollingMovePct(closes: number[], windowSize: number, lookback: number): number {
  let maxMove = 0;
  if (closes.length < windowSize + 1) return 0;
  const start = Math.max(windowSize, closes.length - lookback);
  for (let i = start; i < closes.length; i++) {
    const movePct = Math.abs((closes[i] - closes[i - windowSize]) / closes[i - windowSize]) * 100;
    if (movePct > maxMove) maxMove = movePct;
  }
  return maxMove;
}

function reachable(maxMovePct: number, tpDistancePct: number, multiplier = 1.2): boolean {
  if (tpDistancePct <= 0) return false;
  return maxMovePct / tpDistancePct >= multiplier;
}

describe('trade_feasibility — max rolling 4h move', () => {
  it('returns 0 if closes too short', () => {
    expect(maxRollingMovePct([100, 101, 102], 4, 24)).toBe(0);
  });

  it('finds the largest 4h move in the window', () => {
    // 4h window, prices: ... then a +5% move
    const closes = [100, 100, 100, 100, 100, 105, 100, 100, 100];
    const max = maxRollingMovePct(closes, 4, 24);
    // Largest 4-bar move spans 100→105 = 5%
    expect(max).toBeCloseTo(5, 1);
  });

  it('finds large negative move', () => {
    const closes = [100, 100, 100, 100, 100, 95];
    const max = maxRollingMovePct(closes, 4, 24);
    expect(max).toBeCloseTo(5, 1);
  });

  it('respects lookback window', () => {
    // Big move 30 bars ago, small moves recently
    const closes = [
      100, 100, 100, 100, 110,           // big move at index 4
      ...Array(30).fill(0).map((_, i) => 100 + (i % 2)),
    ];
    const maxFull = maxRollingMovePct(closes, 4, 100);
    const maxLimited = maxRollingMovePct(closes, 4, 20);
    expect(maxFull).toBeGreaterThan(maxLimited);
  });
});

describe('trade_feasibility — reachability', () => {
  const TP_DISTANCE = 0.72; // 1.8 × 0.4% ATR

  it('rejects when max move never reached the TP', () => {
    expect(reachable(0.5, TP_DISTANCE)).toBe(false);  // 0.5/0.72 = 0.69 < 1.2
  });

  it('rejects when max move barely matches TP (no margin)', () => {
    expect(reachable(0.72, TP_DISTANCE)).toBe(false); // ratio 1.0 < 1.2
  });

  it('passes when max move comfortably exceeds TP', () => {
    expect(reachable(1.0, TP_DISTANCE)).toBe(true);   // 1.0/0.72 = 1.39 > 1.2
  });

  it('passes at exactly 1.2× margin', () => {
    expect(reachable(0.864, TP_DISTANCE)).toBe(true); // 0.864/0.72 = 1.2
  });

  it('zero TP distance never passes', () => {
    expect(reachable(5.0, 0)).toBe(false);
  });
});

describe('trade_feasibility — realistic scenarios', () => {
  it('BTC range market should reject', () => {
    // 25 hourly closes, drifting ±0.2% — typical low-vol BTC
    const closes = Array(25).fill(0).map((_, i) => 75000 + Math.sin(i / 3) * 150);
    const max4h = maxRollingMovePct(closes, 4, 24);
    const atrPct = 0.3;
    const tpDist = 1.8 * atrPct;
    // Range market max 4h move is small
    expect(max4h).toBeLessThan(tpDist * 1.2);
    expect(reachable(max4h, tpDist)).toBe(false);
  });

  it('Volatile asset with directional moves should pass', () => {
    // 25 closes simulating a steady uptrend with ~1% candles
    const closes = Array(25).fill(0).map((_, i) => 2300 + i * 25); // +1% per candle approx
    const max4h = maxRollingMovePct(closes, 4, 24);
    const atrPct = 0.5;
    const tpDist = 1.8 * atrPct;  // 0.9%
    // The MAX window is the EARLIEST one (smallest denominator). Verify max comes from
    // a 4-candle stride with the smallest base price in the lookback range.
    expect(max4h).toBeGreaterThan(tpDist * 1.2);  // should easily pass reachability
    expect(reachable(max4h, tpDist)).toBe(true);
  });
});
