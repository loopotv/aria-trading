/**
 * Daily Risk State — capital preservation via UTC-day loss limit.
 *
 * IMPORTANT: equity_start is captured LAZILY at the first call of the UTC day,
 * NOT at midnight UTC. For a low-frequency event-driven bot this is acceptable,
 * but the limit semantically becomes "loss since first activity of the day".
 *
 * Race-safety: PRIMARY KEY on date_utc + INSERT OR IGNORE makes concurrent
 * "first call of the day" idempotent across isolates.
 */

import { logEvent, logError } from '../utils/log';

let schemaEnsured = false;

export interface DailyRiskState {
  dateUtc: string;        // YYYY-MM-DD
  equityStart: number;
  realizedPnl: number;
  halted: boolean;
  initializedAt: string;
  haltedAt: string | null;
}

function utcDateString(now: number = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

async function ensureSchema(db: D1Database): Promise<void> {
  if (schemaEnsured) return;
  try {
    await db.exec(
      `CREATE TABLE IF NOT EXISTS daily_risk_state (date_utc TEXT PRIMARY KEY, equity_start REAL NOT NULL, realized_pnl REAL NOT NULL DEFAULT 0, halted INTEGER NOT NULL DEFAULT 0, initialized_at TEXT NOT NULL DEFAULT (datetime('now')), halted_at TEXT)`
    );
    schemaEnsured = true;
  } catch (err) {
    logError('daily_risk_schema_failed', err);
  }
}

/**
 * Get today's row, creating it lazily with the provided current equity if missing.
 * Returns null only if the DB binding is missing or all writes fail.
 */
export async function getOrCreateDailyState(
  db: D1Database,
  currentEquity: number,
): Promise<DailyRiskState | null> {
  await ensureSchema(db);
  const today = utcDateString();

  try {
    // INSERT OR IGNORE: race-safe across isolates. If two concurrent calls hit
    // this on the first request of the day, only one row is created.
    await db
      .prepare(
        `INSERT OR IGNORE INTO daily_risk_state (date_utc, equity_start) VALUES (?, ?)`
      )
      .bind(today, currentEquity)
      .run();

    const row = await db
      .prepare(
        `SELECT date_utc, equity_start, realized_pnl, halted, initialized_at, halted_at FROM daily_risk_state WHERE date_utc = ?`
      )
      .bind(today)
      .first<{
        date_utc: string;
        equity_start: number;
        realized_pnl: number;
        halted: number;
        initialized_at: string;
        halted_at: string | null;
      }>();

    if (!row) return null;

    // Log only when we just created the row (initialized_at within last 5s)
    const initAge = Date.now() - new Date(row.initialized_at + 'Z').getTime();
    if (initAge < 5000 && row.realized_pnl === 0) {
      logEvent('daily_state_initialized', {
        date_utc: today,
        equity_start: currentEquity,
        first_check_at: new Date().toISOString(),
        note: 'equity_start = equity at FIRST check of the UTC day, not midnight',
      });
    }

    return {
      dateUtc: row.date_utc,
      equityStart: row.equity_start,
      realizedPnl: row.realized_pnl,
      halted: row.halted === 1,
      initializedAt: row.initialized_at,
      haltedAt: row.halted_at,
    };
  } catch (err) {
    logError('daily_state_get_or_create_failed', err);
    return null;
  }
}

/**
 * Add a realized PnL delta to today's row. Idempotent on schema.
 */
export async function addRealizedPnl(db: D1Database, delta: number): Promise<void> {
  await ensureSchema(db);
  const today = utcDateString();
  try {
    await db
      .prepare(`UPDATE daily_risk_state SET realized_pnl = realized_pnl + ? WHERE date_utc = ?`)
      .bind(delta, today)
      .run();
  } catch (err) {
    logError('daily_state_add_pnl_failed', err, { delta });
  }
}

/**
 * Mark the day as halted. Idempotent.
 */
export async function setHalted(db: D1Database): Promise<void> {
  await ensureSchema(db);
  const today = utcDateString();
  try {
    await db
      .prepare(`UPDATE daily_risk_state SET halted = 1, halted_at = datetime('now') WHERE date_utc = ?`)
      .bind(today)
      .run();
    logEvent('daily_loss_halt_triggered', { date_utc: today });
  } catch (err) {
    logError('daily_state_halt_failed', err);
  }
}

/**
 * Returns { halted: true, lossPct } if loss limit is exceeded.
 * Returns { halted: false } otherwise.
 *
 * lossLimitPct = absolute loss percentage threshold (e.g. 2.0 for -2%).
 * Computes lossPct as (currentEquity - equityStart) / equityStart * 100.
 */
export function isOverDailyLossLimit(
  state: DailyRiskState,
  currentEquity: number,
  lossLimitPct: number,
): { halted: boolean; lossPct: number } {
  if (state.equityStart <= 0) return { halted: false, lossPct: 0 };
  const lossPct = ((currentEquity - state.equityStart) / state.equityStart) * 100;
  return { halted: lossPct <= -Math.abs(lossLimitPct), lossPct };
}
