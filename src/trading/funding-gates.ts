/**
 * Funding-rate gates (entry + mid-trade emergency exit).
 *
 * Funding context (Hyperliquid):
 *   - Hourly funding payments. LONGs structurally pay ~11.6% APR baseline.
 *   - High positive funding → LONG too costly to hold. High negative → SHORT pays.
 *
 * Asymmetric thresholds account for the baseline:
 *   - LONG  blocked when annualized funding > +threshold%       (default +50)
 *   - SHORT blocked when annualized funding < -(threshold-15)%  (default -35)
 *   The 15% offset normalizes "real cost above baseline" between sides.
 *
 * Fail-safe: any fetch error → allow trade / don't force-close.
 */

import type { IExchange } from '../exchange/types';
import { logEvent, logError } from '../utils/log';
import { logGate } from './gate-telemetry';

export interface FundingEntryResult {
  allowed: boolean;
  fundingAnnualPct?: number;
}

export interface FundingExitResult {
  exit: boolean;
  fundingAnnualPct?: number;
}

/**
 * Pre-trade entry gate.
 */
export async function checkFundingGate(
  exchange: IExchange,
  asset: string,
  direction: 'LONG' | 'SHORT',
  thresholdPct: number,
  db?: D1Database,
): Promise<FundingEntryResult> {
  if (!exchange.getFundingRate) return { allowed: true };

  let funding: number | null;
  try {
    funding = await exchange.getFundingRate(asset);
  } catch (err) {
    logError('funding_fetch_failed', err, { asset });
    return { allowed: true };
  }
  if (funding == null) return { allowed: true };

  const fundingAnnualPct = funding * 24 * 365 * 100;
  const longThr = thresholdPct;
  const shortThr = -(thresholdPct - 15);

  if (Math.abs(fundingAnnualPct) > 500) {
    logEvent('extreme_funding_detected', {
      asset, funding_annual_pct: fundingAnnualPct, funding_hourly: funding,
    });
  }

  const gateId = direction === 'LONG' ? 'funding_long' : 'funding_short';

  if (direction === 'LONG' && fundingAnnualPct > longThr) {
    logEvent('funding_gate_reject', { asset, direction, funding_annual_pct: fundingAnnualPct, threshold: longThr });
    await logGate(db, {
      gateId, asset, direction, passed: false,
      value: fundingAnnualPct, threshold: longThr,
      reason: 'FUNDING_TOO_HIGH_LONG',
    });
    return { allowed: false, fundingAnnualPct };
  }
  if (direction === 'SHORT' && fundingAnnualPct < shortThr) {
    logEvent('funding_gate_reject', { asset, direction, funding_annual_pct: fundingAnnualPct, threshold: shortThr });
    await logGate(db, {
      gateId, asset, direction, passed: false,
      value: fundingAnnualPct, threshold: shortThr,
      reason: 'FUNDING_TOO_LOW_SHORT',
    });
    return { allowed: false, fundingAnnualPct };
  }

  await logGate(db, {
    gateId, asset, direction, passed: true,
    value: fundingAnnualPct,
    threshold: direction === 'LONG' ? longThr : shortThr,
  });
  return { allowed: true, fundingAnnualPct };
}

/**
 * Mid-trade emergency exit when funding becomes catastrophic.
 * Fail-safe: never force-closes on missing data.
 */
export async function checkEmergencyFundingExit(
  exchange: IExchange,
  asset: string,
  direction: 'LONG' | 'SHORT',
  emergencyThr: number,
  db?: D1Database,
): Promise<FundingExitResult> {
  if (!exchange.getFundingRate) return { exit: false };

  let funding: number | null;
  try {
    funding = await exchange.getFundingRate(asset);
  } catch (err) {
    logError('funding_monitor_fetch_failed', err, { asset });
    return { exit: false };
  }
  if (funding == null) return { exit: false };

  const fundingAnnualPct = funding * 24 * 365 * 100;
  const triggered =
    (direction === 'LONG' && fundingAnnualPct > emergencyThr) ||
    (direction === 'SHORT' && fundingAnnualPct < -emergencyThr);

  await logGate(db, {
    gateId: 'funding_monitor',
    asset,
    direction,
    passed: !triggered,
    value: fundingAnnualPct,
    threshold: direction === 'LONG' ? emergencyThr : -emergencyThr,
    reason: triggered ? 'EMERGENCY_FUNDING_EXIT' : null,
  });

  if (triggered) {
    logEvent('emergency_funding_exit_triggered', {
      asset, direction, funding_annual_pct: fundingAnnualPct, threshold: emergencyThr,
    });
  }
  return { exit: triggered, fundingAnnualPct };
}
