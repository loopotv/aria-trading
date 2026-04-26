/**
 * Gate decision telemetry — append-only log of every gate check (passed or rejected).
 *
 * Used in Step 3 to identify redundant gates by counting reject overlap and
 * computing shadow win-rate of rejected trades. Failure to write telemetry MUST
 * NOT block trade evaluation.
 */

import { logError } from '../utils/log';

let schemaEnsured = false;

export interface GateCheck {
  gateId: string;
  asset?: string | null;
  direction?: 'LONG' | 'SHORT' | null;
  passed: boolean;
  value?: number | null;
  threshold?: number | null;
  reason?: string | null;
}

async function ensureSchema(db: D1Database): Promise<void> {
  if (schemaEnsured) return;
  try {
    await db.exec(
      `CREATE TABLE IF NOT EXISTS gate_telemetry (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, gate_id TEXT NOT NULL, asset TEXT, direction TEXT, passed INTEGER NOT NULL, value REAL, threshold REAL, reason TEXT)`
    );
    await db.exec(`CREATE INDEX IF NOT EXISTS idx_gate_telemetry_ts ON gate_telemetry(ts)`);
    await db.exec(`CREATE INDEX IF NOT EXISTS idx_gate_telemetry_gate ON gate_telemetry(gate_id)`);
    schemaEnsured = true;
  } catch (err) {
    logError('gate_telemetry_schema_failed', err);
  }
}

/**
 * Record a gate decision. Fail-safe: never throws, never blocks the caller.
 */
export async function logGate(db: D1Database | undefined, check: GateCheck): Promise<void> {
  if (!db) return;
  try {
    await ensureSchema(db);
    await db
      .prepare(
        `INSERT INTO gate_telemetry (ts, gate_id, asset, direction, passed, value, threshold, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        Date.now(),
        check.gateId,
        check.asset ?? null,
        check.direction ?? null,
        check.passed ? 1 : 0,
        check.value ?? null,
        check.threshold ?? null,
        check.reason ?? null,
      )
      .run();
  } catch (err) {
    logError('gate_telemetry_insert_failed', err, { gate_id: check.gateId });
  }
}
