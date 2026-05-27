/**
 * Macro regime check: looks at BTC 24h % change as the dominant market direction.
 * Returns one of:
 *   - 'BULL': BTC 24h > +1.5%
 *   - 'BEAR': BTC 24h < -1.5%
 *   - 'NEUTRAL': otherwise
 *
 * Cached for 10 minutes via Cache API to avoid duplicate fetches per cron cycle.
 * Returns 'NEUTRAL' on any fetch error (fail-safe: never block trades on infra issues).
 */

import type { IExchange } from '../exchange/types';

export interface MacroRegime {
  regime: 'BULL' | 'BEAR' | 'NEUTRAL';
  btcPct24h: number;
}

const CACHE_KEY = 'https://aria-internal.cache/macro-btc-24h';

function classifyRegime(btcPct24h: number): MacroRegime {
  const regime: MacroRegime['regime'] =
    btcPct24h > 1.5 ? 'BULL'
    : btcPct24h < -1.5 ? 'BEAR'
    : 'NEUTRAL';
  return { regime, btcPct24h };
}

export async function checkMacroRegime(exchange: IExchange): Promise<MacroRegime> {
  const cache = (caches as any).default as Cache | undefined;

  if (cache) {
    try {
      const cached = await cache.match(CACHE_KEY);
      if (cached) {
        const json = await cached.json() as { btcPct24h: number };
        return classifyRegime(json.btcPct24h);
      }
    } catch { /* fall through */ }
  }

  try {
    const klines = await exchange.getKlines('BTCUSDT', '1h', 25);
    if (!klines || klines.length < 25) return { regime: 'NEUTRAL', btcPct24h: 0 };
    const closes = klines.map((k: any) => parseFloat(k[4]));
    const now = closes[closes.length - 1];
    const ago24h = closes[0];
    const btcPct24h = ago24h > 0 ? ((now - ago24h) / ago24h) * 100 : 0;

    if (cache) {
      try {
        const resp = new Response(JSON.stringify({ btcPct24h }), {
          headers: { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=600' },
        });
        await cache.put(CACHE_KEY, resp);
      } catch { /* best effort */ }
    }

    return classifyRegime(btcPct24h);
  } catch {
    return { regime: 'NEUTRAL', btcPct24h: 0 };
  }
}
