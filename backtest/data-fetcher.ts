/**
 * Downloads historical kline data from Binance Futures public API.
 * No API key required for market data.
 *
 * Usage: npx tsx backtest/data-fetcher.ts
 */

import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, 'data');

const BINANCE_API = 'https://fapi.binance.com';

interface FetchConfig {
  symbols: string[];
  interval: string;
  months: number; // how many months back
}

const CONFIG: FetchConfig = {
  symbols: ['BTCUSDT', 'ETHUSDT'],
  interval: '15m',
  months: 6,
};

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
  if (!res.ok) {
    throw new Error(`Binance API error: ${res.status} ${await res.text()}`);
  }
  return res.json() as Promise<(string | number)[][]>;
}

async function downloadSymbol(symbol: string, interval: string, months: number) {
  console.log(`\nDownloading ${symbol} ${interval} - ${months} months...`);

  const endTime = Date.now();
  const startTime = endTime - months * 30 * 24 * 60 * 60 * 1000;

  const allKlines: (string | number)[][] = [];
  let currentStart = startTime;

  while (currentStart < endTime) {
    const batch = await fetchKlines(symbol, interval, currentStart, endTime);

    if (batch.length === 0) break;

    allKlines.push(...batch);

    // Next batch starts after the last candle
    const lastCloseTime = batch[batch.length - 1][6] as number;
    currentStart = lastCloseTime + 1;

    process.stdout.write(`  ${allKlines.length} candles fetched\r`);

    // Respect rate limits
    await new Promise((r) => setTimeout(r, 200));
  }

  // Deduplicate by openTime
  const seen = new Set<number>();
  const unique = allKlines.filter((k) => {
    const t = k[0] as number;
    if (seen.has(t)) return false;
    seen.add(t);
    return true;
  });

  // Sort by openTime
  unique.sort((a, b) => (a[0] as number) - (b[0] as number));

  const filePath = join(DATA_DIR, `${symbol}_${interval}.json`);
  writeFileSync(filePath, JSON.stringify(unique));

  console.log(`  ${symbol}: ${unique.length} candles saved to ${filePath}`);

  const firstDate = new Date(unique[0][0] as number).toISOString().split('T')[0];
  const lastDate = new Date(unique[unique.length - 1][0] as number).toISOString().split('T')[0];
  console.log(`  Period: ${firstDate} to ${lastDate}`);

  return unique;
}

async function main() {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }

  console.log('=== Binance Futures Kline Data Fetcher ===');
  console.log(`Symbols: ${CONFIG.symbols.join(', ')}`);
  console.log(`Interval: ${CONFIG.interval}`);
  console.log(`Period: ${CONFIG.months} months`);

  for (const symbol of CONFIG.symbols) {
    await downloadSymbol(symbol, CONFIG.interval, CONFIG.months);
  }

  console.log('\nDone!');
}

main().catch(console.error);
