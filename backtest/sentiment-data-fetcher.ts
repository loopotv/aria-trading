/**
 * Downloads historical sentiment data for backtesting:
 * 1. Fear & Greed Index (Alternative.me) - daily, free, from 2018
 * 2. Multi-symbol 1H klines from Binance (for market-neutral strategy)
 *
 * Usage: npx tsx backtest/sentiment-data-fetcher.ts
 */

import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, 'data');

// Top 10 crypto by market cap for market-neutral universe
const SYMBOLS = [
  'BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT',
  'DOGEUSDT', 'ADAUSDT', 'AVAXUSDT', 'DOTUSDT', 'LINKUSDT',
];

const BINANCE_API = 'https://fapi.binance.com';
const MONTHS = 6;

// ==========================================
// Fear & Greed Index
// ==========================================
async function fetchFearAndGreed(): Promise<void> {
  console.log('\n--- Fear & Greed Index ---');
  const days = MONTHS * 30;
  const url = `https://api.alternative.me/fng/?limit=${days}&format=json`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Fear&Greed API error: ${res.status}`);

  const data = (await res.json()) as {
    data: { value: string; timestamp: string; value_classification: string }[];
  };

  // Convert to our format: timestamp + value
  const points = data.data
    .map((d) => ({
      timestamp: parseInt(d.timestamp) * 1000, // seconds to ms
      value: parseInt(d.value),
      classification: d.value_classification,
    }))
    .sort((a, b) => a.timestamp - b.timestamp);

  const filePath = join(DATA_DIR, 'fear_greed.json');
  writeFileSync(filePath, JSON.stringify(points));

  const firstDate = new Date(points[0].timestamp).toISOString().split('T')[0];
  const lastDate = new Date(points[points.length - 1].timestamp).toISOString().split('T')[0];
  console.log(`  ${points.length} data points saved`);
  console.log(`  Period: ${firstDate} to ${lastDate}`);
}

// ==========================================
// Binance Klines (multi-symbol, 1H)
// ==========================================
async function fetchKlines(
  symbol: string,
  interval: string,
  startTime: number,
  endTime: number
): Promise<(string | number)[][]> {
  const url = new URL(`${BINANCE_API}/fapi/v1/klines`);
  url.searchParams.set('symbol', symbol);
  url.searchParams.set('interval', interval);
  url.searchParams.set('startTime', startTime.toString());
  url.searchParams.set('endTime', endTime.toString());
  url.searchParams.set('limit', '1500');

  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`Binance API error: ${res.status} ${await res.text()}`);
  return res.json() as Promise<(string | number)[][]>;
}

async function downloadSymbolKlines(symbol: string, interval: string): Promise<void> {
  const endTime = Date.now();
  const startTime = endTime - MONTHS * 30 * 24 * 60 * 60 * 1000;

  const allKlines: (string | number)[][] = [];
  let currentStart = startTime;

  while (currentStart < endTime) {
    const batch = await fetchKlines(symbol, interval, currentStart, endTime);
    if (batch.length === 0) break;
    allKlines.push(...batch);
    const lastCloseTime = batch[batch.length - 1][6] as number;
    currentStart = lastCloseTime + 1;
    process.stdout.write(`  ${symbol}: ${allKlines.length} candles\r`);
    await new Promise((r) => setTimeout(r, 150));
  }

  // Deduplicate
  const seen = new Set<number>();
  const unique = allKlines
    .filter((k) => {
      const t = k[0] as number;
      if (seen.has(t)) return false;
      seen.add(t);
      return true;
    })
    .sort((a, b) => (a[0] as number) - (b[0] as number));

  const filePath = join(DATA_DIR, `${symbol}_${interval}.json`);
  writeFileSync(filePath, JSON.stringify(unique));
  console.log(`  ${symbol}: ${unique.length} candles saved`);
}

async function fetchAllKlines(): Promise<void> {
  console.log(`\n--- Binance 1H Klines (${SYMBOLS.length} symbols, ${MONTHS} months) ---`);

  for (const symbol of SYMBOLS) {
    await downloadSymbolKlines(symbol, '1h');
  }
}

// ==========================================
// Main
// ==========================================
async function main() {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }

  console.log('=== Sentiment Data Fetcher ===');
  console.log(`Symbols: ${SYMBOLS.join(', ')}`);
  console.log(`Period: ${MONTHS} months`);

  await fetchFearAndGreed();
  await fetchAllKlines();

  console.log('\nDone! Files saved in backtest/data/');
}

main().catch(console.error);
