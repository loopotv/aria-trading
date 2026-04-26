/**
 * Structured JSON logging helper for Cloudflare Workers.
 *
 * Workers Logs preserves JSON payloads, so logging structured data instead of
 * plain strings makes everything queryable (event-name, asset, threshold, etc.)
 * without needing a logger framework.
 *
 * Usage:
 *   logEvent('gate_reject', { gate_id: 'funding_long', asset: 'BTC', value: 67.3, threshold: 50 });
 */
export function logEvent(event: string, data: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ event, ts: Date.now(), ...data }));
}

export function logError(event: string, err: unknown, data: Record<string, unknown> = {}): void {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(JSON.stringify({ event, ts: Date.now(), error: msg.slice(0, 200), ...data }));
}
