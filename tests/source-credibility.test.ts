import { describe, it, expect } from 'vitest';
import { getSourceWeight } from '../src/trading/engine';

describe('getSourceWeight', () => {
  it('binance announcement = 1.5 (ground truth)', () => {
    expect(getSourceWeight('binance_announcement')).toBe(1.5);
  });

  it('tier-1 strong outlets = 1.3', () => {
    expect(getSourceWeight('theblock')).toBe(1.3);
    expect(getSourceWeight('coindesk')).toBe(1.3);
    expect(getSourceWeight('decrypt')).toBe(1.3);
  });

  it('tier-1 base outlets = 1.0', () => {
    expect(getSourceWeight('cointelegraph')).toBe(1.0);
    expect(getSourceWeight('bitcoinmagazine')).toBe(1.0);
  });

  it('cryptocompare aggregator = 0.8', () => {
    expect(getSourceWeight('cryptocompare')).toBe(0.8);
  });

  it('any reddit subreddit = 0.5', () => {
    expect(getSourceWeight('reddit_cryptocurrency')).toBe(0.5);
    expect(getSourceWeight('reddit_btc')).toBe(0.5);
  });

  it('case-insensitive', () => {
    expect(getSourceWeight('COINDESK')).toBe(1.3);
    expect(getSourceWeight('Reddit_CryptoCurrency')).toBe(0.5);
  });

  it('unknown source defaults to 1.0', () => {
    expect(getSourceWeight('twitter_x')).toBe(1.0);
    expect(getSourceWeight('')).toBe(1.0);
  });
});

describe('effective magnitude scenarios (soft modifier, 2026-05-21)', () => {
  // Mirror of the rolled-back formula in engine.ts:
  // sourceShift = (sourceWeight - 1.0) * 0.30  → ±0.15 max
  // confirmShift = min(confirmingSources, 2) * 0.025  → +0.05 max
  // totalShift in [-0.15, +0.20]
  // effectiveMagnitude = clamp(0, 1, magnitude * (1 + totalShift))
  function effective(magnitude: number, sourceWeight: number, confirm: number): number {
    const sourceShift = (sourceWeight - 1.0) * 0.30;
    const confirmShift = Math.min(confirm, 2) * 0.025;
    const totalShift = sourceShift + confirmShift;
    return Math.max(0, Math.min(1.0, magnitude * (1 + totalShift)));
  }

  it('tier-1 (weight 1.0) with no confirmations is unchanged', () => {
    expect(effective(0.5, 1.0, 0)).toBeCloseTo(0.5, 3);
  });

  it('binance announcement (1.5) gives +15% magnitude boost', () => {
    expect(effective(0.5, 1.5, 0)).toBeCloseTo(0.5 * 1.15, 3);
  });

  it('reddit (0.5) gives -15% magnitude penalty but still passes G1 if raw mag was high', () => {
    expect(effective(0.7, 0.5, 0)).toBeCloseTo(0.7 * 0.85, 3); // 0.595, passes G1≥0.5
    expect(effective(0.55, 0.5, 0)).toBeCloseTo(0.55 * 0.85, 3); // 0.4675, fails G1
  });

  it('2 confirmations add +5% boost', () => {
    expect(effective(0.5, 1.0, 2)).toBeCloseTo(0.5 * 1.05, 3);
  });

  it('best case (binance + 2 confirms) caps total shift at +20%', () => {
    expect(effective(0.5, 1.5, 2)).toBeCloseTo(0.5 * 1.20, 3);
  });

  it('confirmation bonus saturates after 2 sources', () => {
    expect(effective(0.5, 1.0, 3)).toBe(effective(0.5, 1.0, 2));
    expect(effective(0.5, 1.0, 5)).toBe(effective(0.5, 1.0, 2));
  });

  it('clamped to 1.0 max', () => {
    expect(effective(0.95, 1.5, 2)).toBe(1.0); // 0.95 * 1.20 = 1.14 → 1.0
  });

  it('cannot block a borderline magnitude alone (soft modifier)', () => {
    // CryptoCompare (0.8) at mag 0.55 with no confirms: 0.55 * (1 + (0.8-1)*0.3) = 0.55 * 0.94 = 0.517
    // Still passes G1 ≥ 0.5
    expect(effective(0.55, 0.8, 0)).toBeGreaterThan(0.5);
  });
});
