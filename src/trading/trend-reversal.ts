/**
 * Check if the trend has reversed against an open position.
 * Returns flipped=true if 2 of 3 signals point opposite to the trade direction:
 *   1. MACD histogram has flipped opposite
 *   2. RSI has crossed 50 against the trade
 *   3. Price has crossed EMA20 against the trade
 * Used by checkSoftOrders to early-exit profitable positions before they decay.
 */

import type { IExchange } from '../exchange/types';
import { calculateRSI, calculateMACD, calculateEMA } from '../utils/indicators';

export interface TrendReversalCheck {
  flipped: boolean;
  signals: string;
}

export async function checkTrendReversal(
  exchange: IExchange,
  symbol: string,
  direction: 'LONG' | 'SHORT',
  currentPrice: number,
): Promise<TrendReversalCheck> {
  try {
    // 2026-05-28: switched from 1h klines (30 candles = 30h history) to 15m klines
    // (60 candles = 15h history). At 4h max holding, 1h candles meant indicators
    // updated only 4 times during the whole trade — too slow. 15m gives 16 updates,
    // catching reversals that develop over 30-45min instead of 1-2h.
    const klines = await exchange.getKlines(symbol, '15m', 60);
    if (!klines?.length || klines.length < 26) {
      return { flipped: false, signals: 'insufficient-data' };
    }

    const closes = klines.map((k: any) => parseFloat(k[4]));
    const rsi = calculateRSI(closes);
    const macd = calculateMACD(closes);
    const ema20Arr = calculateEMA(closes, 20);
    const ema20 = ema20Arr[ema20Arr.length - 1];

    const isLong = direction === 'LONG';

    // Signal 1: MACD histogram flipped against us
    const macdAgainst = isLong ? macd.histogram < 0 : macd.histogram > 0;

    // Signal 2: RSI crossed 50 against us
    const rsiAgainst = isLong ? rsi < 50 : rsi > 50;

    // Signal 3: Mark price crossed EMA20 against us (uses LIVE mark, not stale candle close)
    const priceAgainst = isLong ? currentPrice < ema20 : currentPrice > ema20;

    const flips = [macdAgainst, rsiAgainst, priceAgainst].filter(Boolean).length;
    const signalNames = [
      macdAgainst ? 'MACD' : null,
      rsiAgainst ? 'RSI' : null,
      priceAgainst ? 'EMA20' : null,
    ].filter(Boolean).join('+');

    return { flipped: flips >= 2, signals: signalNames || 'none' };
  } catch (e) {
    console.warn(`[TrendReversal] ${symbol} check failed: ${(e as Error).message?.slice(0, 60)}`);
    return { flipped: false, signals: 'error' };
  }
}
