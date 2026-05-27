/**
 * Build a PriceContext for the LLM sensor by fetching klines on multiple timeframes.
 * Returns null if any fetch fails (LLM falls back to text-only mode).
 */

import type { IExchange } from '../exchange/types';
import type { PriceContext } from '../sentiment/llm-sensor';

export async function buildPriceContext(
  exchange: IExchange,
  asset: string,
): Promise<PriceContext | null> {
  const symbol = asset + 'USDT';
  if (!exchange.isSymbolAvailable(symbol)) return null;
  try {
    // Fetch in parallel: 5m (60 bars = 5h), 1h (24 bars = 1d), no 4h needed (covered by 1h)
    const [k5m, k1h] = await Promise.all([
      exchange.getKlines(symbol, '5m', 60),
      exchange.getKlines(symbol, '1h', 25),
    ]);
    if (!k5m?.length || !k1h?.length) return null;

    const close5m = (idx: number) => parseFloat((k5m[k5m.length - 1 - idx] || [])[4] as any);
    const close1h = (idx: number) => parseFloat((k1h[k1h.length - 1 - idx] || [])[4] as any);
    const current = close5m(0);
    const p5mAgo = close5m(1);
    const p1hAgo = close5m(12);  // 12 × 5m = 1h
    const p4hAgo = close1h(4);
    const p24hAgo = close1h(24);

    const pct = (now: number, then: number) => then > 0 ? ((now - then) / then) * 100 : 0;

    // Volume ratio: last 24h vol / 7-day average (use 1h klines: last 24 vs avg of all 25)
    const vols = k1h.map((k: any) => parseFloat(k[5]));
    const last24Vol = vols.slice(-24).reduce((a, b) => a + b, 0);
    const avgPer24 = vols.reduce((a, b) => a + b, 0) * (24 / vols.length);
    const volRatio24h = avgPer24 > 0 ? last24Vol / avgPer24 : 1;

    return {
      asset,
      current,
      pct5m: pct(current, p5mAgo),
      pct1h: pct(current, p1hAgo),
      pct4h: pct(current, p4hAgo),
      pct24h: pct(current, p24hAgo),
      volRatio24h,
    };
  } catch (e) {
    console.warn(`[PriceContext] ${asset} failed: ${(e as Error).message?.slice(0, 60)}`);
    return null;
  }
}
