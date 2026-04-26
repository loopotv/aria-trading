import { describe, it, expect } from 'vitest';
import { isOverDailyLossLimit, type DailyRiskState } from '../src/trading/daily-risk';

function mkState(equityStart: number, halted = false): DailyRiskState {
  return {
    dateUtc: '2026-04-26',
    equityStart,
    realizedPnl: 0,
    halted,
    initializedAt: '2026-04-26 12:00:00',
    haltedAt: null,
  };
}

describe('isOverDailyLossLimit', () => {
  it('does not halt when equity unchanged', () => {
    const r = isOverDailyLossLimit(mkState(100), 100, 2.0);
    expect(r.halted).toBe(false);
    expect(r.lossPct).toBeCloseTo(0);
  });

  it('does not halt at -1.99% with -2.0% limit', () => {
    const r = isOverDailyLossLimit(mkState(100), 98.01, 2.0);
    expect(r.halted).toBe(false);
    expect(r.lossPct).toBeCloseTo(-1.99, 1);
  });

  it('halts exactly at -2.0% with -2.0% limit', () => {
    const r = isOverDailyLossLimit(mkState(100), 98.0, 2.0);
    expect(r.halted).toBe(true);
  });

  it('halts at -3% with -2.0% limit', () => {
    const r = isOverDailyLossLimit(mkState(100), 97.0, 2.0);
    expect(r.halted).toBe(true);
    expect(r.lossPct).toBeCloseTo(-3.0);
  });

  it('does not halt on profit', () => {
    const r = isOverDailyLossLimit(mkState(100), 105, 2.0);
    expect(r.halted).toBe(false);
    expect(r.lossPct).toBeCloseTo(5.0);
  });

  it('handles tiny equity_start safely', () => {
    const r = isOverDailyLossLimit(mkState(0), 0, 2.0);
    expect(r.halted).toBe(false);
  });

  it('treats negative limit as absolute', () => {
    // limit passed as -2.0 should behave like 2.0
    const r = isOverDailyLossLimit(mkState(100), 97.0, -2.0);
    expect(r.halted).toBe(true);
  });
});
