/**
 * SlowTrail — book-wide exit strategy (replaces the old TP/partial-TP/trend-reversal/timeout combo).
 *
 * Imported from hyper-trader fork (2026-06-10): the only exit under which the
 * short-breakdown selection keeps its edge, and the honest runner-up on random
 * long entries (gold +0.304 vs MidPatience +0.010) in their exit study.
 *
 * Rules (per side, signs mirrored for SHORT):
 *  - Full initial stop (regime-ATR, set at entry) stays untouched until the trail
 *    overtakes it. NO take-profit anywhere.
 *  - Track the best favorable close (`bestClose`, sampled at cron ticks).
 *  - After 6h held, if the peak excursion is positive, trail a stop that gives
 *    back at most 2% of the peak: stop = bestClose -/+ 0.02 * peak. Ratchet-only.
 *  - Production-faithful clamp: if the candidate stop is already at/through the
 *    current price, a real STOP_MARKET there would trigger instantly — close at
 *    market NOW instead of pretending a resting stop exists (no phantom fills).
 *  - Hard deadline: force-close at 48h.
 *
 * Pure function, no I/O — unit-tested in tests/slowtrail.test.ts.
 */

export const SLOWTRAIL_ARM_MS = 6 * 60 * 60 * 1000; // trail arms after 6h held
export const SLOWTRAIL_GIVEBACK = 0.02; // give back 2% of the peak excursion
export const SLOWTRAIL_DEADLINE_MS = 48 * 60 * 60 * 1000; // hard close at 48h

export interface SlowTrailState {
  direction: 'LONG' | 'SHORT';
  entryPrice: number;
  openedAt: number; // ms epoch
  stopLoss: number; // current (possibly already ratcheted) stop
  bestClose: number; // best favorable close seen so far (init = entryPrice)
}

export interface SlowTrailDecision {
  /** Updated best favorable close — caller must persist it on the order. */
  bestClose: number;
  action: 'none' | 'ratchet' | 'close_market';
  /** New (tighter) stop when action === 'ratchet'. */
  newStop?: number;
  reason: string;
}

export function evaluateSlowTrail(
  state: SlowTrailState,
  currentPrice: number,
  nowMs: number,
): SlowTrailDecision {
  const isLong = state.direction === 'LONG';
  const s = isLong ? 1 : -1;

  // Track the best favorable close (monotone per direction).
  const bestClose =
    s * (currentPrice - state.bestClose) > 0 ? currentPrice : state.bestClose;

  const heldMs = nowMs - state.openedAt;

  // Hard deadline first: 48h and out, win or lose.
  if (heldMs >= SLOWTRAIL_DEADLINE_MS) {
    return {
      bestClose,
      action: 'close_market',
      reason: `SlowTrail deadline (held ${(heldMs / 3600000).toFixed(1)}h)`,
    };
  }

  // Phase 1 (patience): before 6h only the full initial stop protects.
  if (heldMs < SLOWTRAIL_ARM_MS) {
    return { bestClose, action: 'none', reason: 'trail not armed (<6h)' };
  }

  // Phase 2 (trail): only meaningful with a positive peak excursion.
  const peak = s * (bestClose - state.entryPrice);
  if (peak <= 0) {
    return { bestClose, action: 'none', reason: 'no favorable excursion' };
  }

  const candidate = bestClose - s * SLOWTRAIL_GIVEBACK * peak;

  // Ratchet-only: never loosen the current stop.
  if (s * (candidate - state.stopLoss) <= 0) {
    return { bestClose, action: 'none', reason: 'candidate not tighter' };
  }

  // Production-faithful clamp: a stop at/through the market can't rest — it
  // would fill instantly. Close at market instead of phantom-filling.
  if (s * (currentPrice - candidate) <= 0) {
    return {
      bestClose,
      action: 'close_market',
      reason: `SlowTrail stop (give-back level ${candidate.toFixed(6)} reached)`,
    };
  }

  return {
    bestClose,
    action: 'ratchet',
    newStop: candidate,
    reason: `SlowTrail ratchet (peak ${peak.toFixed(6)})`,
  };
}
