/**
 * News-Outcome Backfill — Fase 1 dell'audit 2026-06-11.
 *
 * THE question this answers: does the LLM sentiment actually predict price?
 * 18k+ news have been classified since April but price_1h/4h/24h_change and
 * was_correct were NEVER populated — the entire event-driven strategy has been
 * running on an unvalidated signal.
 *
 * Every cron tick, this job:
 *   1. Selects up to NEWS_BATCH_LIMIT recent news (last 36h) with
 *      |sentiment| ≥ 0.5, a known non-MARKET asset, and at least one horizon
 *      elapsed but not yet recorded.
 *   2. Groups them by asset (ONE kline fetch per asset — Workers subrequest budget).
 *   3. Computes price change from classification time (processed_at) to +1h/+4h/+24h
 *      using 1h kline closes (within-hour precision is fine for this study).
 *   4. Sets was_correct once the 4h change is known: sentiment direction matches
 *      4h price direction. (4h ≈ our trading horizon.)
 *
 * Sentinels:
 *   was_correct = -1  → unprocessable (symbol not on exchange / klines unavailable);
 *                       prevents infinite re-processing. Filter `was_correct IN (0,1)`
 *                       in any accuracy analysis.
 *
 * Read results via GET /debug/sensor-accuracy.
 */

import type { IExchange } from '../exchange/types';
import { logEvent, logError } from '../utils/log';

const NEWS_BATCH_LIMIT = 40;   // max news rows per run
const MAX_ASSETS_PER_RUN = 8;  // max kline fetches per run (subrequest budget)
const LOOKBACK_HOURS = 40;     // window must outlast the 24h horizon so the 24h fill lands before rows age out
const HOUR_MS = 3600_000;

interface PendingNewsRow {
  id: number;
  asset: string;
  sentiment_score: number;
  processed_at: string; // 'YYYY-MM-DD HH:MM:SS' UTC
  price_1h_change: number | null;
  price_4h_change: number | null;
  price_24h_change: number | null;
}

/** Parse D1's "YYYY-MM-DD HH:MM:SS" (UTC) into ms epoch. */
export function parseDbUtc(ts: string): number {
  return Date.parse(ts.replace(' ', 'T') + 'Z');
}

/**
 * Build an hour-bucket → close map from 1h klines.
 * k[0] = open time ms, k[4] = close.
 */
export function buildHourCloseMap(klines: number[][]): Map<number, number> {
  const map = new Map<number, number>();
  for (const k of klines) {
    const openTime = Number(k[0]);
    const close = parseFloat(k[4] as unknown as string);
    if (Number.isFinite(openTime) && Number.isFinite(close)) {
      map.set(Math.floor(openTime / HOUR_MS), close);
    }
  }
  return map;
}

/** Close of the 1h bar containing t, or null if we don't have that bar. */
export function priceAt(hourCloses: Map<number, number>, tMs: number): number | null {
  return hourCloses.get(Math.floor(tMs / HOUR_MS)) ?? null;
}

/** % change between two hour-bucketed prices around t0 and t0+horizon. */
export function pctChange(
  hourCloses: Map<number, number>,
  t0Ms: number,
  horizonMs: number,
): number | null {
  const p0 = priceAt(hourCloses, t0Ms);
  const p1 = priceAt(hourCloses, t0Ms + horizonMs);
  if (p0 == null || p1 == null || p0 <= 0) return null;
  return ((p1 - p0) / p0) * 100;
}

export interface BackfillStats {
  scanned: number;
  updated: number;
  skippedUnprocessable: number;
  assetsFetched: number;
}

export async function backfillNewsOutcomes(
  db: D1Database,
  exchange: IExchange,
  nowMs: number = Date.now(),
): Promise<BackfillStats> {
  const stats: BackfillStats = { scanned: 0, updated: 0, skippedUnprocessable: 0, assetsFetched: 0 };

  // Pending = row not yet fully measured (24h horizon still missing) AND not the
  // -1 unprocessable sentinel. NOTE: we key "still pending" on price_24h_change,
  // NOT on was_correct. was_correct is set as soon as the 4h outcome is known, but
  // the 24h column needs the row to be re-visited later (up to 24-36h after
  // processed_at). Gating on was_correct used to retire rows at the 4h mark, leaving
  // price_24h_change NULL forever — which starved the 24h-horizon study. (2026-06-17)
  const pending = await db
    .prepare(
      `SELECT id, asset, sentiment_score, processed_at,
              price_1h_change, price_4h_change, price_24h_change
       FROM news_events
       WHERE sentiment_score IS NOT NULL
         AND ABS(sentiment_score) >= 0.5
         AND asset IS NOT NULL AND asset != 'MARKET'
         AND price_24h_change IS NULL
         AND (was_correct IS NULL OR was_correct >= 0)
         AND processed_at > datetime('now', '-${LOOKBACK_HOURS} hours')
         AND processed_at < datetime('now', '-1 hours')
       ORDER BY processed_at ASC
       LIMIT ${NEWS_BATCH_LIMIT}`
    )
    .all<PendingNewsRow>();

  const rows = pending.results || [];
  stats.scanned = rows.length;
  if (rows.length === 0) return stats;

  // Group by asset, cap distinct assets per run.
  const byAsset = new Map<string, PendingNewsRow[]>();
  for (const r of rows) {
    if (!byAsset.has(r.asset) && byAsset.size >= MAX_ASSETS_PER_RUN) continue;
    const list = byAsset.get(r.asset) || [];
    list.push(r);
    byAsset.set(r.asset, list);
  }

  const updates: D1PreparedStatement[] = [];

  for (const [asset, assetRows] of byAsset) {
    const symbol = asset + 'USDT';

    if (!exchange.isSymbolAvailable(symbol)) {
      // Unprocessable: mark with sentinel so we never re-query these rows.
      for (const r of assetRows) {
        updates.push(
          db.prepare(`UPDATE news_events SET was_correct = -1 WHERE id = ?`).bind(r.id)
        );
        stats.skippedUnprocessable++;
      }
      continue;
    }

    let hourCloses: Map<number, number>;
    try {
      // 64 bars of 1h covers the 40h lookback + 24h horizon with margin.
      const klines = await exchange.getKlines(symbol, '1h', 64);
      stats.assetsFetched++;
      if (!klines?.length) throw new Error('empty klines');
      hourCloses = buildHourCloseMap(klines);
    } catch (err) {
      logError('news_outcome_klines_failed', err, { asset });
      continue; // transient — retry next run, no sentinel
    }

    for (const r of assetRows) {
      const t0 = parseDbUtc(r.processed_at);
      if (!Number.isFinite(t0)) {
        updates.push(db.prepare(`UPDATE news_events SET was_correct = -1 WHERE id = ?`).bind(r.id));
        stats.skippedUnprocessable++;
        continue;
      }

      const elapsed = nowMs - t0;
      // Compute ONLY columns still missing — a row revisited for its 24h fill must
      // not re-write its already-known 1h/4h values every tick.
      const c1h = r.price_1h_change == null && elapsed >= 1 * HOUR_MS ? pctChange(hourCloses, t0, 1 * HOUR_MS) : null;
      const c4h = r.price_4h_change == null && elapsed >= 4 * HOUR_MS ? pctChange(hourCloses, t0, 4 * HOUR_MS) : null;
      const c24h = r.price_24h_change == null && elapsed >= 24 * HOUR_MS ? pctChange(hourCloses, t0, 24 * HOUR_MS) : null;

      // was_correct: set once the 4h outcome is known (our trading horizon), using
      // the newly-computed 4h value or one already stored. Direction match between
      // sentiment and 4h price change.
      const eff4h = c4h ?? r.price_4h_change;
      let wasCorrect: number | null = null;
      if (eff4h != null && r.price_24h_change == null) {
        const sentimentUp = r.sentiment_score > 0;
        wasCorrect = (sentimentUp === eff4h > 0) ? 1 : 0;
      }

      // Only write if we have something new to persist.
      if (c1h == null && c4h == null && c24h == null) continue;

      updates.push(
        db.prepare(
          `UPDATE news_events
           SET price_1h_change = COALESCE(?, price_1h_change),
               price_4h_change = COALESCE(?, price_4h_change),
               price_24h_change = COALESCE(?, price_24h_change),
               was_correct = COALESCE(?, was_correct)
           WHERE id = ?`
        ).bind(c1h, c4h, c24h, wasCorrect, r.id)
      );
      stats.updated++;
    }
  }

  if (updates.length > 0) {
    try {
      await db.batch(updates);
    } catch (err) {
      logError('news_outcome_batch_failed', err, { count: updates.length });
      stats.updated = 0;
    }
  }

  if (stats.updated > 0 || stats.skippedUnprocessable > 0) {
    logEvent('news_outcome_backfill', stats as unknown as Record<string, unknown>);
  }
  return stats;
}
