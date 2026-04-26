/**
 * Tests for the funding-rate gate logic. Tests the pure math helpers
 * (annualization, threshold comparison) without invoking the full engine.
 *
 * The actual checkFundingGate / checkEmergencyFundingExit methods on
 * TradingEngine wrap these with telemetry + Telegram I/O and are integration-
 * tested separately.
 */

import { describe, it, expect } from 'vitest';

// Replicate the asymmetric threshold logic so we can test it in isolation.
// Mirror of: longThr = baseThr; shortThr = -(baseThr - 15)
function thresholds(baseThr: number) {
  return { long: baseThr, short: -(baseThr - 15) };
}

function fundingAnnualPct(hourlyRate: number): number {
  return hourlyRate * 24 * 365 * 100;
}

function shouldRejectLong(fundingHourly: number, baseThr: number): boolean {
  return fundingAnnualPct(fundingHourly) > thresholds(baseThr).long;
}

function shouldRejectShort(fundingHourly: number, baseThr: number): boolean {
  return fundingAnnualPct(fundingHourly) < thresholds(baseThr).short;
}

function shouldEmergencyExit(fundingHourly: number, direction: 'LONG' | 'SHORT', emergencyThr: number): boolean {
  const annual = fundingAnnualPct(fundingHourly);
  return (direction === 'LONG' && annual > emergencyThr) ||
         (direction === 'SHORT' && annual < -emergencyThr);
}

describe('Funding annualization', () => {
  it('converts hourly to annual %', () => {
    // 0.0000125/h ≈ 11% APR (Hyperliquid baseline)
    expect(fundingAnnualPct(0.0000125)).toBeCloseTo(10.95, 1);
  });

  it('handles negative funding (shorts paying longs)', () => {
    expect(fundingAnnualPct(-0.0001)).toBeCloseTo(-87.6, 1);
  });

  it('handles extreme funding (cap)', () => {
    // 4%/h cap on Hyperliquid = 35040% APR
    expect(fundingAnnualPct(0.04)).toBeCloseTo(35040);
  });
});

describe('Asymmetric thresholds (baseThr=50)', () => {
  it('LONG threshold is +50%', () => {
    expect(thresholds(50).long).toBe(50);
  });

  it('SHORT threshold is -35% (asymmetric for baseline)', () => {
    expect(thresholds(50).short).toBe(-35);
  });
});

describe('Entry gate boundary cases', () => {
  it('LONG passes at exactly +50% APR (not strict greater-than)', () => {
    // 50% APR = 50/(24*365)/100 hourly
    const hourly = 50 / (24 * 365 * 100);
    expect(shouldRejectLong(hourly, 50)).toBe(false);
  });

  it('LONG rejects just above +50% APR', () => {
    const hourly = 50.01 / (24 * 365 * 100);
    expect(shouldRejectLong(hourly, 50)).toBe(true);
  });

  it('SHORT passes at exactly -35% APR', () => {
    const hourly = -35 / (24 * 365 * 100);
    expect(shouldRejectShort(hourly, 50)).toBe(false);
  });

  it('SHORT rejects just below -35% APR', () => {
    const hourly = -35.01 / (24 * 365 * 100);
    expect(shouldRejectShort(hourly, 50)).toBe(true);
  });

  it('positive funding does not affect SHORT (short receives)', () => {
    const hourly = 0.0001; // +87.6% APR — bad for LONG, irrelevant for SHORT
    expect(shouldRejectShort(hourly, 50)).toBe(false);
  });

  it('negative funding does not affect LONG (long receives)', () => {
    const hourly = -0.0001; // -87.6% APR — bad for SHORT, irrelevant for LONG
    expect(shouldRejectLong(hourly, 50)).toBe(false);
  });
});

describe('Emergency exit thresholds (>500% APR)', () => {
  it('LONG triggers emergency at 501% APR', () => {
    const hourly = 501 / (24 * 365 * 100);
    expect(shouldEmergencyExit(hourly, 'LONG', 500)).toBe(true);
  });

  it('LONG does not trigger at 499% APR', () => {
    const hourly = 499 / (24 * 365 * 100);
    expect(shouldEmergencyExit(hourly, 'LONG', 500)).toBe(false);
  });

  it('SHORT triggers emergency at -501% APR', () => {
    const hourly = -501 / (24 * 365 * 100);
    expect(shouldEmergencyExit(hourly, 'SHORT', 500)).toBe(true);
  });

  it('SHORT does not trigger at -499% APR', () => {
    const hourly = -499 / (24 * 365 * 100);
    expect(shouldEmergencyExit(hourly, 'SHORT', 500)).toBe(false);
  });

  it('extreme +1000% APR triggers LONG emergency', () => {
    const hourly = 1000 / (24 * 365 * 100);
    expect(shouldEmergencyExit(hourly, 'LONG', 500)).toBe(true);
  });

  it('extreme funding cap (35040% APR) triggers LONG emergency', () => {
    expect(shouldEmergencyExit(0.04, 'LONG', 500)).toBe(true);
  });
});
