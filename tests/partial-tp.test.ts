/**
 * Tests for the partial-TP + break-even-shift logic introduced 2026-05-21.
 *
 * The production logic is intertwined with the engine's checkSoftOrders loop;
 * here we test the pure trigger and SL-shift math in isolation.
 */
import { describe, it, expect } from 'vitest';

// Mirror of engine.ts production rules:
//   partial triggers at entry ± 1.0 × ATR
//   new SL after partial = entry ± 0.1 × ATR  (LONG: +, SHORT: -)
//   close 50% of current position quantity
function partialTriggered(
  direction: 'LONG' | 'SHORT',
  currentPrice: number,
  entry: number,
  atr: number,
): boolean {
  if (direction === 'LONG') return currentPrice >= entry + atr * 1.0;
  return currentPrice <= entry - atr * 1.0;
}

function postPartialSL(
  direction: 'LONG' | 'SHORT',
  entry: number,
  atr: number,
): number {
  const buffer = atr * 0.1;
  return direction === 'LONG' ? entry + buffer : entry - buffer;
}

function partialQty(currentQty: number): number {
  return currentQty * 0.5;
}

describe('partial TP trigger', () => {
  const entry = 100;
  const atr = 2.0;

  it('LONG triggers exactly at entry + 1.0×ATR', () => {
    expect(partialTriggered('LONG', 102, entry, atr)).toBe(true);
  });

  it('LONG does not trigger just below threshold', () => {
    expect(partialTriggered('LONG', 101.99, entry, atr)).toBe(false);
  });

  it('LONG triggers comfortably above threshold', () => {
    expect(partialTriggered('LONG', 103.5, entry, atr)).toBe(true);
  });

  it('SHORT triggers exactly at entry - 1.0×ATR', () => {
    expect(partialTriggered('SHORT', 98, entry, atr)).toBe(true);
  });

  it('SHORT does not trigger just above threshold', () => {
    expect(partialTriggered('SHORT', 98.01, entry, atr)).toBe(false);
  });

  it('LONG below entry never triggers', () => {
    expect(partialTriggered('LONG', 99, entry, atr)).toBe(false);
    expect(partialTriggered('LONG', 95, entry, atr)).toBe(false);
  });

  it('SHORT above entry never triggers', () => {
    expect(partialTriggered('SHORT', 101, entry, atr)).toBe(false);
  });
});

describe('post-partial SL = break-even + buffer', () => {
  const atr = 2.0;

  it('LONG SL moves to entry + 0.1×ATR', () => {
    expect(postPartialSL('LONG', 100, atr)).toBeCloseTo(100.2, 6);
  });

  it('SHORT SL moves to entry - 0.1×ATR', () => {
    expect(postPartialSL('SHORT', 100, atr)).toBeCloseTo(99.8, 6);
  });

  it('LONG SL is always above entry (guarantees small profit on any retest)', () => {
    expect(postPartialSL('LONG', 50, 1.0)).toBeGreaterThan(50);
  });

  it('SHORT SL is always below entry', () => {
    expect(postPartialSL('SHORT', 50, 1.0)).toBeLessThan(50);
  });
});

describe('partial quantity = 50%', () => {
  it('halves the current position', () => {
    expect(partialQty(0.001)).toBeCloseTo(0.0005, 7);
    expect(partialQty(10)).toBe(5);
  });
});

describe('end-to-end scenarios', () => {
  // BTC LONG @ $78,000, ATR=$300, qty=0.001
  const entry = 78000;
  const atr = 300;
  const qty = 0.001;

  it('partial triggers at $78,300, remaining 0.0005 with SL $78,030', () => {
    const triggerPrice = entry + atr; // $78,300
    expect(partialTriggered('LONG', triggerPrice, entry, atr)).toBe(true);
    const remaining = qty - partialQty(qty);
    expect(remaining).toBeCloseTo(0.0005, 7);
    expect(postPartialSL('LONG', entry, atr)).toBeCloseTo(78030, 1);
  });

  it('after partial, free-roll losers exit at BE+buffer (small win)', () => {
    // Price retests entry → SL at 78,030 hits before price reaches 78,000
    const newSL = postPartialSL('LONG', entry, atr); // 78,030
    const minSafeExit = newSL; // worst case: SL hit
    expect(minSafeExit).toBeGreaterThan(entry); // never goes negative on the remainder
  });

  it('after partial, free-roll winners reach TP (1.8×ATR) for full payout', () => {
    const tp = entry + atr * 1.8; // 78,540
    const partialProfit = (entry + atr - entry) * partialQty(qty); // $0.15
    const finalProfit = (tp - entry) * (qty - partialQty(qty)); // 0.0005 × 540 = $0.27
    const total = partialProfit + finalProfit;
    expect(total).toBeCloseTo(0.42, 2);
  });
});
