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

describe('effective magnitude scenarios', () => {
  // Mirror of the formula in engine.ts:
  // effectiveMagnitude = min(1.0, magnitude * sourceWeight * confirmationBonus)
  // confirmationBonus = 1 + min(confirmingSources, 2) * 0.2
  function effective(magnitude: number, sourceWeight: number, confirm: number): number {
    const bonus = 1 + Math.min(confirm, 2) * 0.2;
    return Math.min(1.0, magnitude * sourceWeight * bonus);
  }

  it('binance announcement at mag 0.4 passes G1 (≥0.5)', () => {
    expect(effective(0.4, 1.5, 0)).toBeCloseTo(0.6, 2);
  });

  it('reddit at mag 0.6 fails G1 (no confirmation)', () => {
    expect(effective(0.6, 0.5, 0)).toBeCloseTo(0.3, 2);
  });

  it('cryptocompare at mag 0.5 + 2 confirmations just passes', () => {
    // 0.5 × 0.8 × 1.4 = 0.56
    expect(effective(0.5, 0.8, 2)).toBeCloseTo(0.56, 2);
  });

  it('cryptocompare at mag 0.5 + 1 confirmation fails', () => {
    // 0.5 × 0.8 × 1.2 = 0.48
    expect(effective(0.5, 0.8, 1)).toBeCloseTo(0.48, 2);
  });

  it('confirmation bonus caps at 2 extra sources', () => {
    // 3, 4, 5 confirmations all give the same 1.4x bonus
    expect(effective(0.5, 1.0, 3)).toBe(effective(0.5, 1.0, 2));
    expect(effective(0.5, 1.0, 5)).toBe(effective(0.5, 1.0, 2));
  });

  it('effective magnitude capped at 1.0', () => {
    // Binance + 3 confirmations: 1.0 × 1.5 × 1.4 = 2.1 → capped to 1.0
    expect(effective(1.0, 1.5, 3)).toBe(1.0);
  });
});
