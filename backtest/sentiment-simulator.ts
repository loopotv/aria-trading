/**
 * Sentiment simulator - proxies LLM sentiment for backtesting.
 *
 * Since we can't run LLMs retroactively on historical news at scale,
 * this module creates sentiment scores from available historical data:
 * 1. Fear & Greed Index → market-wide sentiment
 * 2. Price momentum → asset-specific sentiment proxy
 * 3. Volume spikes → event magnitude proxy
 */

import { SentimentSnapshot } from '../src/sentiment/types';

interface FearGreedPoint {
  timestamp: number;
  value: number; // 0-100
  classification: string;
}

export interface SimulatedSentimentData {
  fearGreed: FearGreedPoint[];
  // Per-symbol kline data for momentum/volume calculation
  symbolKlines: Map<string, number[][]>;
}

/**
 * Generate sentiment snapshots for all symbols at a given timestamp.
 * Uses a composite of:
 * - Fear & Greed Index (market-wide mood)
 * - Short-term momentum (7-candle return) per asset
 * - Volume ratio (current vs average) as magnitude
 */
export function generateSentimentSnapshots(
  data: SimulatedSentimentData,
  symbols: string[],
  timestamp: number,
  windowSize: number = 24 // 24 hourly candles = 1 day lookback
): SentimentSnapshot[] {
  // Get Fear & Greed value for this date
  const fgValue = getNearestFearGreed(data.fearGreed, timestamp);
  // Normalize: 0-100 → -1 to +1 (50 = neutral)
  const marketSentiment = (fgValue - 50) / 50;

  const snapshots: SentimentSnapshot[] = [];

  for (const symbol of symbols) {
    const klines = data.symbolKlines.get(symbol);
    if (!klines) continue;

    // Find the candle index at this timestamp
    const idx = findCandleIndex(klines, timestamp);
    if (idx < windowSize) continue;

    const window = klines.slice(idx - windowSize, idx);
    const closes = window.map((k) => parseFloat(k[4] as unknown as string));
    const volumes = window.map((k) => parseFloat(k[5] as unknown as string));

    // Asset-specific momentum: 7-candle return
    const recentCloses = closes.slice(-7);
    const momentum = recentCloses.length >= 2
      ? (recentCloses[recentCloses.length - 1] - recentCloses[0]) / recentCloses[0]
      : 0;

    // Normalize momentum to [-1, 1] (cap at ±5% as extreme)
    const momentumScore = Math.max(-1, Math.min(1, momentum / 0.05));

    // Volume ratio: current vs 20-period average
    const avgVol = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;
    const currentVol = volumes[volumes.length - 1] || avgVol;
    const volumeRatio = avgVol > 0 ? currentVol / avgVol : 1;
    // Normalize: 1.0 = average, >1.5 = high activity
    const magnitude = Math.min(1, Math.max(0, (volumeRatio - 0.5) / 1.5));

    // Composite sentiment: 40% market + 50% momentum + 10% noise reduction
    const compositeScore = Math.max(-1, Math.min(1,
      marketSentiment * 0.4 + momentumScore * 0.5 + (magnitude > 0.7 ? momentumScore * 0.1 : 0)
    ));

    snapshots.push({
      asset: symbol.replace('USDT', ''),
      compositeScore,
      signalCount: Math.round(magnitude * 10) + 1, // proxy for news volume
      freshnessHours: 1,
      avgConfidence: 0.6 + magnitude * 0.3, // higher volume = higher confidence
      avgMagnitude: magnitude,
      timestamp,
    });
  }

  return snapshots;
}

function getNearestFearGreed(
  data: FearGreedPoint[],
  timestamp: number
): number {
  if (data.length === 0) return 50; // neutral default

  // Find the closest data point (Fear&Greed is daily)
  let closest = data[0];
  let minDiff = Math.abs(timestamp - data[0].timestamp);

  for (const point of data) {
    const diff = Math.abs(timestamp - point.timestamp);
    if (diff < minDiff) {
      minDiff = diff;
      closest = point;
    }
    // data is sorted, if we passed the timestamp, stop
    if (point.timestamp > timestamp) break;
  }

  return closest.value;
}

function findCandleIndex(
  klines: number[][],
  timestamp: number
): number {
  // Binary search for nearest candle
  let lo = 0;
  let hi = klines.length - 1;

  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if ((klines[mid][0] as number) < timestamp) lo = mid + 1;
    else hi = mid;
  }

  return lo;
}
