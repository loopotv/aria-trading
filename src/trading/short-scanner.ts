/**
 * Short-breakdown scanner — autonomous SHORT sleeve.
 *
 * Once per hour, scans the top-cap whitelist for alts matching the short-breakdown
 * conditions (see strategies/short-breakdown.ts) and opens up to MAX_SHORT_SLEEVE
 * positions, ranked by atrPct (highest volatility first — the strategy's edge).
 *
 * No news/LLM dependency. When BTC is falling >2.5%/24h, this sleeve naturally
 * hedges the long event-driven book; otherwise it stays silent.
 *
 * Adapted from hyper-trader for our smaller account / simpler infrastructure:
 *   - Scans the full whitelist in ONE invocation (not chunked) — our cron is 5min,
 *     not the fork's chunk-budget cadence. 40 symbols × 1 kline fetch = OK.
 *   - State minimal: just last_hour_scanned in memory (per-isolate). On cold start
 *     re-scan — no problem, the BTC gate filters most hours anyway.
 *
 * Fail-closed by design:
 *   - BTC klines error → abort, no positions opened
 *   - Per-symbol error → symbol skipped
 *   - sleeve full (≥2 SHORTs from this scanner) → silent skip
 */

import type { IExchange } from '../exchange/types';
import type { TelegramBot } from '../telegram/bot';
import { evaluateShortBreakdown, R3T25S2 } from './strategies/short-breakdown';
import { logEvent, logError } from '../utils/log';

export const MAX_SHORT_SLEEVE = 2;
export const SHORT_SCANNER_STRATEGY = 'short-breakdown';
/**
 * SIGNAL-ONLY MODE (2026-07-08). When false, the scanner runs and logs every
 * eligible candidate to short_scan_signals (Part B study) but does NOT open real
 * positions. Decision after -$4.68 all-time on this sleeve (62% of total drawdown),
 * -$0.75 in the first fully-fixed week, and a 3.3% 4h hit-rate in Part B's first
 * window — the entry signal is unproven at best.
 * RE-ENABLE CRITERION (pre-committed): flip to true only when /debug/shortscan-accuracy
 * shows 4h hit-rate ≥ 50% across ≥ 3 DISTINCT breakdown windows (different days).
 */
export const SHORT_SCANNER_LIVE = false;
export const TP_ATR_MULT = 2.5; // SHORT take-profit distance in ATRs (exit backtest, 2026-06-26)
// Per-symbol re-entry cooldown (2026-06-29). The scanner is meant to run hourly, but
// its isolate-local throttle lets it re-scan every tick; without a persistent guard a
// position that just closed gets re-opened seconds later on the same unchanged 1h setup
// — pure fee churn (WLD closed -0.06 at 03:15, re-opened 19s later). Mirror the hourly
// cadence per symbol, regardless of win/loss.
export const SHORT_REENTRY_COOLDOWN_MS = 60 * 60 * 1000;
const HOUR_MS = 3600_000;
const KLINE_LIMIT = 60;

// Per-isolate state. Worst case: cold start re-scans an already-scanned hour
// (idempotent — sleeve check + dedup-per-symbol prevents double-open).
let lastHourScanned: number | null = null;

export interface ShortScanCandidate {
  symbol: string;
  asset: string;
  atrPct: number;
  price: number;
  atr: number;
  adx: number;
  stopLoss: number;
  takeProfit: number;
}

export interface ShortScanResult {
  ran: boolean;
  reason: string;
  candidates: ShortScanCandidate[];      // the subset we will open (ranked, sliced to free slots)
  allEligible?: ShortScanCandidate[];    // ALL eligible this scan (ranked) — for the Part B signal study
  btcRet24h?: number;                    // BTC 24h return at scan time (decimal)
}

/**
 * Compute BTC 24h return from 1h klines.
 * Returns null on fetch error (fail-closed: caller should abort).
 */
async function fetchBtcReturn24h(exchange: IExchange): Promise<number | null> {
  try {
    const klines = await exchange.getKlines('BTCUSDT', '1h', 25);
    if (!klines || klines.length < 25) return null;
    const closes = klines.map((k: any) => parseFloat(k[4]));
    const now = closes[closes.length - 1];
    const ago24h = closes[0];
    if (!(ago24h > 0)) return null;
    return (now - ago24h) / ago24h;
  } catch {
    return null;
  }
}

/**
 * Main entrypoint. Called from the cron loop once per cycle.
 * - Returns early if already scanned this hour
 * - Returns early if BTC is not down enough
 * - Returns early if sleeve already at MAX
 * - Otherwise scans whitelist, opens up to MAX_SHORT_SLEEVE new SHORTs
 */
export async function runShortBreakdownScan(args: {
  exchange: IExchange;
  telegram: TelegramBot;
  whitelist: ReadonlySet<string>;
  currentSleeveCount: number; // count of existing short-breakdown SHORTs in book
  nowMs: number;
}): Promise<ShortScanResult> {
  const { exchange, telegram, whitelist, currentSleeveCount, nowMs } = args;
  const hourKey = Math.floor(nowMs / HOUR_MS);

  // Skip if we already ran in this hour
  if (lastHourScanned === hourKey) {
    return { ran: false, reason: 'already_scanned_this_hour', candidates: [] };
  }

  // Sleeve full → no point in scanning
  if (currentSleeveCount >= MAX_SHORT_SLEEVE) {
    lastHourScanned = hourKey;
    return { ran: false, reason: `sleeve_full_${currentSleeveCount}/${MAX_SHORT_SLEEVE}`, candidates: [] };
  }

  // BTC gate
  const btcRet24h = await fetchBtcReturn24h(exchange);
  if (btcRet24h == null) {
    return { ran: false, reason: 'btc_fetch_failed', candidates: [] };
  }
  if (!(btcRet24h < R3T25S2.BTC_RET_24H_MAX)) {
    lastHourScanned = hourKey;
    return { ran: false, reason: `btc_not_down_${(btcRet24h * 100).toFixed(2)}%`, candidates: [] };
  }

  // BTC is down — scan whitelist (skip BTC itself)
  const universe = [...whitelist].filter(s => s !== 'BTCUSDT');
  const candidates: ShortScanCandidate[] = [];

  for (const symbol of universe) {
    try {
      const klines = await exchange.getKlines(symbol, '1h', KLINE_LIMIT);
      if (!klines || klines.length < R3T25S2.KLINE_LIMIT_REQUIRED) continue;

      const highs = klines.map((k: any) => parseFloat(k[2]));
      const lows = klines.map((k: any) => parseFloat(k[3]));
      const closes = klines.map((k: any) => parseFloat(k[4]));

      const result = evaluateShortBreakdown(highs, lows, closes, btcRet24h);
      if (!result.eligible) continue;

      const price = closes[closes.length - 1];
      const atr = result.atrPct * price;
      // SHORT SL: 1.3×ATR above entry (matches event-driven slMultiplier)
      const stopLoss = price + atr * 1.3;
      // SHORT TP: TP_ATR_MULT×ATR below entry. Added 2026-06-26 after the exit
      // backtest on 43 trades: the entry signal has a ~4.5% avg favorable excursion
      // (MFE) that the slow trail kept giving back. A real resting TP order captures
      // it intrabar on the favorable side (no soft-SL poll slippage). 2.5×ATR ≈ the
      // average MFE; best simulated sum-return of the policies tested.
      const takeProfit = price - atr * TP_ATR_MULT;

      candidates.push({
        symbol,
        asset: symbol.replace(/USDT$/, ''),
        atrPct: result.atrPct,
        price,
        atr,
        adx: result.indicators.adx,
        stopLoss,
        takeProfit,
      });
    } catch (err) {
      logError('short_scan_symbol_failed', err, { symbol });
    }
  }

  lastHourScanned = hourKey;

  if (candidates.length === 0) {
    return { ran: true, reason: 'no_eligible_candidates', candidates: [] };
  }

  // Rank by atrPct DESC (highest volatility first = strategy's edge)
  candidates.sort((a, b) => b.atrPct - a.atrPct);

  const slotsAvailable = MAX_SHORT_SLEEVE - currentSleeveCount;
  const toOpen = candidates.slice(0, slotsAvailable);

  logEvent('short_scan_completed', {
    btc_ret_24h_pct: btcRet24h * 100,
    universe_size: universe.length,
    eligible_count: candidates.length,
    slots_available: slotsAvailable,
    top_picks: toOpen.map(c => ({ symbol: c.symbol, atrPct: c.atrPct, adx: c.adx })),
  });

  // Telegram digest (no individual opens here — caller orchestrates executeTrade)
  await telegram.sendMessage(
    `🔻 <b>Short-Breakdown Scan${SHORT_SCANNER_LIVE ? '' : ' — 📋 SIGNAL-ONLY (no trades)'}</b>\n\n` +
    `BTC 24h: <code>${(btcRet24h * 100).toFixed(2)}%</code>\n` +
    `Eligible: ${candidates.length} | Slots: ${slotsAvailable}\n` +
    `Top picks (by ATR%):\n` +
    toOpen.map(c => `• <code>${c.symbol}</code> ATR=${(c.atrPct * 100).toFixed(2)}% ADX=${c.adx.toFixed(0)}`).join('\n')
  );

  return { ran: true, reason: 'scan_completed', candidates: toOpen, allEligible: candidates, btcRet24h };
}

/** For testing or admin: reset the hour cache. */
export function resetShortScannerCache(): void {
  lastHourScanned = null;
}
