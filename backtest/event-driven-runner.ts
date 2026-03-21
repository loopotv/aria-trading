/**
 * Event-Driven Strategy Backtest
 *
 * Uses REAL historical news from CryptoCompare + simulated LLM sentiment
 * to test: news event → sentiment extraction → quant filter → trade.
 *
 * Since we can't run the LLM retroactively at scale, we simulate
 * the sentiment extraction using heuristics on the news metadata.
 *
 * Usage: npx tsx backtest/event-driven-runner.ts
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { SentimentSignal } from '../src/sentiment/types';
import { evaluateEventSignal, EventTradeSetup } from '../src/trading/strategies/event-driven';
import { calculatePositionSize } from '../src/trading/risk';
import { Trade, EquityPoint, calculateMetrics, printReport } from './metrics';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, 'data');

const ASSET_MAP: Record<string, string> = {
  BTC: 'BTCUSDT', ETH: 'ETHUSDT', BNB: 'BNBUSDT', SOL: 'SOLUSDT',
  XRP: 'XRPUSDT', DOGE: 'DOGEUSDT', ADA: 'ADAUSDT', AVAX: 'AVAXUSDT',
  DOT: 'DOTUSDT', LINK: 'LINKUSDT',
};

const CONFIG = {
  initialBalance: 10_000,
  leverage: 3,
  riskPerTrade: 1.5,
  maxPositionSizeUsdt: 800,
  maxPositions: 3,
  makerFee: 0.0002,
  takerFee: 0.0004,
  slippagePercent: 0.001, // Higher slippage for event-driven (urgency)
  windowSize: 48,
  timeoutHours: 4,
};

// High-impact keywords for simulated LLM
const HIGH_IMPACT: Record<string, { score: number; magnitude: number }> = {
  'hack': { score: -0.9, magnitude: 0.9 },
  'exploit': { score: -0.85, magnitude: 0.85 },
  'breach': { score: -0.8, magnitude: 0.8 },
  'stolen': { score: -0.8, magnitude: 0.8 },
  'sec lawsuit': { score: -0.7, magnitude: 0.8 },
  'sec charges': { score: -0.75, magnitude: 0.85 },
  'ban': { score: -0.6, magnitude: 0.7 },
  'etf approved': { score: 0.9, magnitude: 0.95 },
  'etf approval': { score: 0.85, magnitude: 0.9 },
  'etf rejected': { score: -0.7, magnitude: 0.8 },
  'listing': { score: 0.6, magnitude: 0.6 },
  'delisting': { score: -0.7, magnitude: 0.7 },
  'partnership': { score: 0.5, magnitude: 0.5 },
  'acquisition': { score: 0.6, magnitude: 0.65 },
  'upgrade': { score: 0.4, magnitude: 0.5 },
  'mainnet': { score: 0.5, magnitude: 0.55 },
  'airdrop': { score: 0.3, magnitude: 0.4 },
  'crash': { score: -0.8, magnitude: 0.85 },
  'flash crash': { score: -0.9, magnitude: 0.9 },
  'liquidation': { score: -0.6, magnitude: 0.7 },
  'blackrock': { score: 0.7, magnitude: 0.75 },
  'fidelity': { score: 0.6, magnitude: 0.65 },
  'grayscale': { score: 0.5, magnitude: 0.6 },
  'halving': { score: 0.7, magnitude: 0.8 },
  'fork': { score: 0.3, magnitude: 0.5 },
  'whale': { score: 0.2, magnitude: 0.4 },
  'record high': { score: 0.7, magnitude: 0.7 },
  'all time high': { score: 0.7, magnitude: 0.7 },
  'rally': { score: 0.5, magnitude: 0.5 },
  'surge': { score: 0.5, magnitude: 0.5 },
  'plunge': { score: -0.6, magnitude: 0.6 },
  'drop': { score: -0.3, magnitude: 0.3 },
};

interface HistoricalArticle {
  id: string;
  title: string;
  body: string;
  publishedOn: number;
  categories: string;
  source: string;
}

interface OpenPosition {
  symbol: string;
  direction: 'LONG' | 'SHORT';
  entryPrice: number;
  quantity: number;
  stopLoss: number;
  takeProfit: number;
  entryTime: number;
  timeoutTime: number;
}

/**
 * Simulate LLM sentiment extraction from a news article.
 * Uses keyword matching as a proxy for the real LLM.
 */
function simulateSentiment(article: HistoricalArticle): SentimentSignal | null {
  const text = `${article.title} ${article.body}`.toLowerCase();
  const categories = article.categories.split('|').map((c) => c.trim().toUpperCase());

  // Find the primary asset
  let primaryAsset = 'MARKET';
  for (const cat of categories) {
    if (ASSET_MAP[cat]) {
      primaryAsset = cat;
      break;
    }
  }

  // Match keywords
  let bestScore = 0;
  let bestMagnitude = 0;
  let matched = false;

  for (const [keyword, params] of Object.entries(HIGH_IMPACT)) {
    if (text.includes(keyword)) {
      if (Math.abs(params.score) > Math.abs(bestScore)) {
        bestScore = params.score;
        bestMagnitude = params.magnitude;
        matched = true;
      }
    }
  }

  if (!matched || primaryAsset === 'MARKET') return null;

  return {
    asset: primaryAsset,
    sentimentScore: bestScore,
    confidence: 0.7 + bestMagnitude * 0.2,
    magnitude: bestMagnitude,
    direction: bestScore > 0 ? 'positive' : 'negative',
    source: 'cryptocompare_historical',
    category: 'event',
    timestamp: article.publishedOn * 1000,
  };
}

function loadData() {
  const newsPath = join(DATA_DIR, 'historical_news.json');
  if (!existsSync(newsPath)) {
    console.error('Historical news not found. Run: npm run backtest:fetch-events');
    process.exit(1);
  }

  const news: HistoricalArticle[] = JSON.parse(readFileSync(newsPath, 'utf-8'));
  console.log(`Loaded ${news.length} historical articles`);

  // Load klines
  const symbolKlines = new Map<string, number[][]>();
  for (const [asset, symbol] of Object.entries(ASSET_MAP)) {
    const path = join(DATA_DIR, `${symbol}_1h.json`);
    if (!existsSync(path)) continue;
    symbolKlines.set(symbol, JSON.parse(readFileSync(path, 'utf-8')));
  }
  console.log(`Loaded klines for ${symbolKlines.size} symbols`);

  return { news, symbolKlines };
}

function findCandleIndex(klines: number[][], timestampMs: number): number {
  let lo = 0;
  let hi = klines.length - 1;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if ((klines[mid][0] as number) < timestampMs) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function runBacktest() {
  console.log('=== EVENT-DRIVEN STRATEGY BACKTEST ===\n');

  const { news, symbolKlines } = loadData();

  let balance = CONFIG.initialBalance;
  const trades: Trade[] = [];
  const equityCurve: EquityPoint[] = [];
  const openPositions: OpenPosition[] = [];
  let eventsDetected = 0;
  let eventsFiltered = 0;
  let eventsTraded = 0;

  // Process news articles chronologically
  for (const article of news) {
    const timestamp = article.publishedOn * 1000;

    // --- Check SL/TP/Timeout for open positions ---
    for (let p = openPositions.length - 1; p >= 0; p--) {
      const pos = openPositions[p];
      const klines = symbolKlines.get(pos.symbol);
      if (!klines) continue;

      const candleIdx = findCandleIndex(klines, timestamp);
      if (candleIdx <= 0 || candleIdx >= klines.length) continue;

      const candle = klines[candleIdx];
      const high = parseFloat(candle[2] as unknown as string);
      const low = parseFloat(candle[3] as unknown as string);

      let exitPrice = 0;
      let exitReason: 'SL' | 'TP' | 'SIGNAL' = 'SL';

      // Timeout check
      if (timestamp >= pos.timeoutTime) {
        exitPrice = parseFloat(candle[4] as unknown as string);
        exitReason = 'SIGNAL'; // timeout
      } else if (pos.direction === 'LONG') {
        if (low <= pos.stopLoss) exitPrice = pos.stopLoss;
        else if (high >= pos.takeProfit) { exitPrice = pos.takeProfit; exitReason = 'TP'; }
      } else {
        if (high >= pos.stopLoss) exitPrice = pos.stopLoss;
        else if (low <= pos.takeProfit) { exitPrice = pos.takeProfit; exitReason = 'TP'; }
      }

      if (exitPrice > 0) {
        const slip = exitPrice * CONFIG.slippagePercent;
        if (pos.direction === 'LONG') exitPrice -= slip;
        else exitPrice += slip;

        const rawPnl = pos.direction === 'LONG'
          ? (exitPrice - pos.entryPrice) * (pos.quantity / pos.entryPrice)
          : (pos.entryPrice - exitPrice) * (pos.quantity / pos.entryPrice);

        const fees = pos.quantity * (CONFIG.makerFee + CONFIG.takerFee);
        const pnl = rawPnl - fees;
        balance += pnl;

        trades.push({
          symbol: pos.symbol,
          direction: pos.direction,
          entryPrice: pos.entryPrice,
          exitPrice,
          quantity: pos.quantity,
          pnl,
          pnlPercent: (pnl / pos.quantity) * 100,
          entryTime: pos.entryTime,
          exitTime: timestamp,
          exitReason,
        });

        openPositions.splice(p, 1);
      }
    }

    // Record equity
    equityCurve.push({ timestamp, balance, drawdown: 0 });

    // --- Simulate LLM sentiment extraction ---
    const signal = simulateSentiment(article);
    if (!signal) continue;
    eventsDetected++;

    // --- Check if we already have a position on this symbol ---
    const symbol = signal.asset + 'USDT';
    if (openPositions.some((p) => p.symbol === symbol)) continue;
    if (openPositions.length >= CONFIG.maxPositions) continue;

    // --- Get kline data for quant filter ---
    const klines = symbolKlines.get(symbol);
    if (!klines) continue;

    const candleIdx = findCandleIndex(klines, timestamp);
    if (candleIdx < CONFIG.windowSize) continue;

    const window = klines.slice(candleIdx - CONFIG.windowSize, candleIdx);
    const highs = window.map((k) => parseFloat(k[2] as unknown as string));
    const lows = window.map((k) => parseFloat(k[3] as unknown as string));
    const closes = window.map((k) => parseFloat(k[4] as unknown as string));
    const volumes = window.map((k) => parseFloat(k[5] as unknown as string));
    const currentPrice = closes[closes.length - 1];

    // --- Quant filter ---
    const setup = evaluateEventSignal(signal, highs, lows, closes, volumes, currentPrice);

    if (!setup.approved) {
      eventsFiltered++;
      continue;
    }

    // --- Position sizing ---
    const posSize = calculatePositionSize(
      balance, CONFIG.riskPerTrade, currentPrice,
      setup.stopLoss, CONFIG.leverage, CONFIG.maxPositionSizeUsdt
    );
    if (posSize <= 0) continue;

    // --- Open position ---
    const entrySlip = currentPrice * CONFIG.slippagePercent;
    const entryPrice = setup.direction === 'LONG'
      ? currentPrice + entrySlip
      : currentPrice - entrySlip;

    openPositions.push({
      symbol,
      direction: setup.direction,
      entryPrice,
      quantity: posSize,
      stopLoss: setup.stopLoss,
      takeProfit: setup.takeProfit,
      entryTime: timestamp,
      timeoutTime: timestamp + CONFIG.timeoutHours * 60 * 60 * 1000,
    });

    eventsTraded++;
  }

  // Close remaining positions
  for (const pos of openPositions) {
    const klines = symbolKlines.get(pos.symbol);
    if (!klines) continue;
    const exitPrice = parseFloat(klines[klines.length - 1][4] as unknown as string);
    const rawPnl = pos.direction === 'LONG'
      ? (exitPrice - pos.entryPrice) * (pos.quantity / pos.entryPrice)
      : (pos.entryPrice - exitPrice) * (pos.quantity / pos.entryPrice);
    const fees = pos.quantity * (CONFIG.makerFee + CONFIG.takerFee);
    balance += rawPnl - fees;
    trades.push({
      symbol: pos.symbol, direction: pos.direction,
      entryPrice: pos.entryPrice, exitPrice,
      quantity: pos.quantity, pnl: rawPnl - fees,
      pnlPercent: ((rawPnl - fees) / pos.quantity) * 100,
      entryTime: pos.entryTime, exitTime: Date.now(),
      exitReason: 'SIGNAL',
    });
  }

  // Print results
  const metrics = calculateMetrics(trades, CONFIG.initialBalance, equityCurve);
  printReport(metrics, CONFIG.initialBalance);

  console.log('\n--- EVENT PIPELINE STATS ---');
  console.log(`  Total articles:    ${news.length}`);
  console.log(`  Events detected:   ${eventsDetected} (${(eventsDetected / news.length * 100).toFixed(1)}% of articles)`);
  console.log(`  Filtered out:      ${eventsFiltered} (${eventsDetected > 0 ? (eventsFiltered / eventsDetected * 100).toFixed(1) : 0}% of events)`);
  console.log(`  Trades executed:   ${eventsTraded}`);
  console.log(`  Conversion rate:   ${eventsDetected > 0 ? (eventsTraded / eventsDetected * 100).toFixed(1) : 0}%`);

  // By direction
  const longTrades = trades.filter((t) => t.direction === 'LONG');
  const shortTrades = trades.filter((t) => t.direction === 'SHORT');
  const longPnl = longTrades.reduce((s, t) => s + t.pnl, 0);
  const shortPnl = shortTrades.reduce((s, t) => s + t.pnl, 0);
  console.log(`\n  LONG:  ${longTrades.length} trades, ${longPnl >= 0 ? '+' : ''}$${longPnl.toFixed(2)}`);
  console.log(`  SHORT: ${shortTrades.length} trades, ${shortPnl >= 0 ? '+' : ''}$${shortPnl.toFixed(2)}`);

  // By symbol
  console.log('\n--- BY SYMBOL ---');
  for (const [asset, symbol] of Object.entries(ASSET_MAP)) {
    const st = trades.filter((t) => t.symbol === symbol);
    if (st.length === 0) continue;
    const sp = st.reduce((s, t) => s + t.pnl, 0);
    const sw = st.filter((t) => t.pnl > 0).length;
    console.log(
      `  ${symbol.padEnd(10)} ${String(st.length).padStart(3)} trades  ` +
      `${(sw / st.length * 100).toFixed(0).padStart(3)}% win  ` +
      `${sp >= 0 ? '+' : ''}$${sp.toFixed(2)}`
    );
  }

  // Exit reasons
  console.log('\n--- EXIT REASONS ---');
  const sl = trades.filter((t) => t.exitReason === 'SL');
  const tp = trades.filter((t) => t.exitReason === 'TP');
  const sig = trades.filter((t) => t.exitReason === 'SIGNAL');
  if (trades.length > 0) {
    console.log(`  SL hit:     ${sl.length} (${(sl.length / trades.length * 100).toFixed(1)}%)`);
    console.log(`  TP hit:     ${tp.length} (${(tp.length / trades.length * 100).toFixed(1)}%)`);
    console.log(`  Timeout:    ${sig.length} (${(sig.length / trades.length * 100).toFixed(1)}%)`);
  }
}

runBacktest();
