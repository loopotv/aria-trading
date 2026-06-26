/**
 * Short-Scan Outcome study — Part B (2026-06-26).
 *
 * THE question: does the short-breakdown ENTRY signal actually predict price down,
 * independent of our exit and execution? Part A (retroactive, on opened trades only)
 * showed a 4h hit-rate of 37% and the loss was execution, not logic — but that was a
 * survivorship-biased sample (only what we opened). This logs EVERY eligible candidate
 * each scan (opened or not) and backfills the forward price outcome, so we can measure:
 *   - directional hit-rate at 4h / 24h on the full eligible set,
 *   - per-condition attribution (ATR%, ADX, BTC regime, rank),
 *   - whether ranking by ATR% picks the best (opened vs not-opened).
 *
 * Sentinels: was_correct = -1 → unprocessable (klines unavailable). Filter
 * `was_correct IN (0,1)` in any accuracy analysis. Read via /debug/shortscan-accuracy.
 */

import type { IExchange } from '../exchange/types';
import { logEvent, logError } from '../utils/log';
import { buildHourCloseMap, priceAt } from './news-outcome';
import type { ShortScanCandidate } from './short-scanner';

const HOUR_MS = 3600_000;
const BATCH_LIMIT = 60;
const MAX_ASSETS_PER_RUN = 8;
const LOOKBACK_HOURS = 40; // must outlast the 24h horizon so the 24h fill lands before rows age out

/**
 * Persist every eligible candidate from one scan. `allEligible` is ranked by ATR%
 * DESC (rank 1 = top pick). `openedSymbols` flags which ones we actually opened.
 */
export async function logShortScanSignals(
  db: D1Database,
  allEligible: ShortScanCandidate[],
  btcRet24h: number,
  openedSymbols: Set<string>,
  signalTs: number,
): Promise<void> {
  if (!allEligible.length) return;
  const stmts = allEligible.map((c, i) =>
    db
      .prepare(
        `INSERT INTO short_scan_signals
          (symbol, signal_ts, entry_price, atr_pct, adx, btc_ret_24h, rank, eligible_count, opened)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        c.symbol,
        signalTs,
        c.price,
        c.atrPct,
        c.adx,
        btcRet24h,
        i + 1,
        allEligible.length,
        openedSymbols.has(c.symbol) ? 1 : 0,
      )
  );
  try {
    await db.batch(stmts);
    logEvent('shortscan_signals_logged', { count: stmts.length, eligible: allEligible.length });
  } catch (err) {
    logError('shortscan_log_failed', err, { count: stmts.length });
  }
}

interface PendingSig {
  id: number;
  symbol: string;
  signal_ts: number;
  entry_price: number;
  price_4h_change: number | null;
  price_24h_change: number | null;
}

export interface ShortScanBackfillStats {
  scanned: number;
  updated: number;
  skippedUnprocessable: number;
  assetsFetched: number;
}

/**
 * Backfill forward outcomes for logged short-scan signals. Mirrors news-outcome:
 * one kline fetch per asset, fills 4h/24h % change + MFE/MAE relative to entry,
 * sets was_correct once the 4h outcome is known (short correct ⇔ price fell).
 */
export async function backfillShortScanOutcomes(
  db: D1Database,
  exchange: IExchange,
  nowMs: number = Date.now(),
): Promise<ShortScanBackfillStats> {
  const stats: ShortScanBackfillStats = { scanned: 0, updated: 0, skippedUnprocessable: 0, assetsFetched: 0 };

  const minTs = nowMs - LOOKBACK_HOURS * HOUR_MS;
  const maxTs = nowMs - 1 * HOUR_MS; // need ≥1h elapsed
  const pending = await db
    .prepare(
      `SELECT id, symbol, signal_ts, entry_price, price_4h_change, price_24h_change
       FROM short_scan_signals
       WHERE price_24h_change IS NULL
         AND (was_correct IS NULL OR was_correct >= 0)
         AND signal_ts > ? AND signal_ts < ?
       ORDER BY signal_ts ASC
       LIMIT ${BATCH_LIMIT}`
    )
    .bind(minTs, maxTs)
    .all<PendingSig>();

  const rows = pending.results || [];
  stats.scanned = rows.length;
  if (rows.length === 0) return stats;

  // Group by symbol, cap distinct assets per run (subrequest budget).
  const bySymbol = new Map<string, PendingSig[]>();
  for (const r of rows) {
    if (!bySymbol.has(r.symbol) && bySymbol.size >= MAX_ASSETS_PER_RUN) continue;
    const list = bySymbol.get(r.symbol) || [];
    list.push(r);
    bySymbol.set(r.symbol, list);
  }

  const updates: D1PreparedStatement[] = [];

  for (const [symbol, sigRows] of bySymbol) {
    if (!exchange.isSymbolAvailable(symbol)) {
      for (const r of sigRows) {
        updates.push(db.prepare(`UPDATE short_scan_signals SET was_correct = -1 WHERE id = ?`).bind(r.id));
        stats.skippedUnprocessable++;
      }
      continue;
    }

    let klines: number[][];
    try {
      klines = await exchange.getKlines(symbol, '1h', 64);
      stats.assetsFetched++;
      if (!klines?.length) throw new Error('empty klines');
    } catch (err) {
      logError('shortscan_klines_failed', err, { symbol });
      continue; // transient — retry next run
    }
    const closeMap = buildHourCloseMap(klines);
    // [openTime, o, h, l, c, v, closeTime]
    const bars = klines.map((k) => ({ t: Number(k[0]), h: Number(k[2]), l: Number(k[3]) }));

    for (const r of sigRows) {
      const t0 = r.signal_ts;
      const entry = r.entry_price;
      if (!Number.isFinite(t0) || !(entry > 0)) {
        updates.push(db.prepare(`UPDATE short_scan_signals SET was_correct = -1 WHERE id = ?`).bind(r.id));
        stats.skippedUnprocessable++;
        continue;
      }
      const elapsed = nowMs - t0;

      const pctTo = (horizonMs: number): number | null => {
        const p = priceAt(closeMap, t0 + horizonMs);
        return p == null ? null : ((p - entry) / entry) * 100;
      };

      const c4h = r.price_4h_change == null && elapsed >= 4 * HOUR_MS ? pctTo(4 * HOUR_MS) : null;
      const c24h = r.price_24h_change == null && elapsed >= 24 * HOUR_MS ? pctTo(24 * HOUR_MS) : null;

      // MFE/MAE over the 0-24h window (only once the full window has elapsed).
      let mfe: number | null = null;
      let mae: number | null = null;
      if (elapsed >= 24 * HOUR_MS) {
        const win = bars.filter((b) => b.t >= t0 && b.t <= t0 + 24 * HOUR_MS);
        if (win.length) {
          const minLow = Math.min(...win.map((b) => b.l));
          const maxHigh = Math.max(...win.map((b) => b.h));
          mfe = ((entry - minLow) / entry) * 100; // favorable (down) for a short
          mae = ((maxHigh - entry) / entry) * 100; // adverse (up)
        }
      }

      // was_correct once the 4h outcome is known: short correct ⇔ price fell.
      const eff4h = c4h ?? r.price_4h_change;
      let wasCorrect: number | null = null;
      if (eff4h != null && r.price_24h_change == null) wasCorrect = eff4h < 0 ? 1 : 0;

      if (c4h == null && c24h == null && mfe == null) continue; // nothing new

      updates.push(
        db
          .prepare(
            `UPDATE short_scan_signals
             SET price_4h_change = COALESCE(?, price_4h_change),
                 price_24h_change = COALESCE(?, price_24h_change),
                 mfe_24h = COALESCE(?, mfe_24h),
                 mae_24h = COALESCE(?, mae_24h),
                 was_correct = COALESCE(?, was_correct)
             WHERE id = ?`
          )
          .bind(c4h, c24h, mfe, mae, wasCorrect, r.id)
      );
      stats.updated++;
    }
  }

  if (updates.length > 0) {
    try {
      await db.batch(updates);
    } catch (err) {
      logError('shortscan_backfill_batch_failed', err, { count: updates.length });
      stats.updated = 0;
    }
  }

  if (stats.updated > 0 || stats.skippedUnprocessable > 0) {
    logEvent('shortscan_outcome_backfill', stats as unknown as Record<string, unknown>);
  }
  return stats;
}
