import { describe, it, expect } from 'vitest';
import {
  parseDbUtc,
  buildHourCloseMap,
  priceAt,
  pctChange,
} from '../src/trading/news-outcome';

const HOUR_MS = 3600_000;

describe('parseDbUtc', () => {
  it('parses D1 datetime format as UTC', () => {
    const ms = parseDbUtc('2026-06-11 08:30:00');
    expect(ms).toBe(Date.parse('2026-06-11T08:30:00Z'));
  });

  it('returns NaN on garbage', () => {
    expect(Number.isFinite(parseDbUtc('not-a-date'))).toBe(false);
  });
});

describe('buildHourCloseMap + priceAt', () => {
  // Klines: [openTime, open, high, low, close, volume]
  const t0 = Date.parse('2026-06-11T00:00:00Z');
  const klines = [
    [t0 + 0 * HOUR_MS, 100, 101, 99, 100, 1000],
    [t0 + 1 * HOUR_MS, 100, 103, 100, 102, 1000],
    [t0 + 2 * HOUR_MS, 102, 105, 101, 104, 1000],
  ] as unknown as number[][];

  it('maps each hour bucket to its close', () => {
    const map = buildHourCloseMap(klines);
    expect(map.size).toBe(3);
    expect(priceAt(map, t0)).toBe(100);
    expect(priceAt(map, t0 + 1 * HOUR_MS)).toBe(102);
  });

  it('mid-hour timestamp resolves to containing bar', () => {
    const map = buildHourCloseMap(klines);
    expect(priceAt(map, t0 + 1 * HOUR_MS + 30 * 60_000)).toBe(102);
  });

  it('returns null outside coverage', () => {
    const map = buildHourCloseMap(klines);
    expect(priceAt(map, t0 + 10 * HOUR_MS)).toBeNull();
    expect(priceAt(map, t0 - 1 * HOUR_MS)).toBeNull();
  });
});

describe('pctChange', () => {
  const t0 = Date.parse('2026-06-11T00:00:00Z');
  const klines = Array.from({ length: 30 }, (_, i) => [
    t0 + i * HOUR_MS, 100, 101, 99, 100 + i, 1000,
  ]) as unknown as number[][];
  const map = buildHourCloseMap(klines);

  it('computes % change over 4h horizon', () => {
    // close at t0 = 100, close at t0+4h = 104 → +4%
    expect(pctChange(map, t0, 4 * HOUR_MS)).toBeCloseTo(4.0, 6);
  });

  it('computes % change over 24h horizon', () => {
    // close at t0 = 100, close at t0+24h = 124 → +24%
    expect(pctChange(map, t0, 24 * HOUR_MS)).toBeCloseTo(24.0, 6);
  });

  it('null when horizon bar missing', () => {
    expect(pctChange(map, t0 + 28 * HOUR_MS, 4 * HOUR_MS)).toBeNull();
  });

  it('null when t0 bar missing', () => {
    expect(pctChange(map, t0 - 5 * HOUR_MS, 4 * HOUR_MS)).toBeNull();
  });
});

describe('was_correct semantics (direction match)', () => {
  // Mirror of the production rule: (sentiment > 0) === (c4h > 0)
  const wasCorrect = (sentiment: number, c4h: number) =>
    ((sentiment > 0) === (c4h > 0)) ? 1 : 0;

  it('bullish sentiment + price up = correct', () => {
    expect(wasCorrect(0.8, 1.2)).toBe(1);
  });
  it('bullish sentiment + price down = wrong', () => {
    expect(wasCorrect(0.8, -0.5)).toBe(0);
  });
  it('bearish sentiment + price down = correct', () => {
    expect(wasCorrect(-0.7, -2.1)).toBe(1);
  });
  it('bearish sentiment + price up = wrong', () => {
    expect(wasCorrect(-0.7, 0.3)).toBe(0);
  });
});
