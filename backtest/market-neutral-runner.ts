/**
 * Market Neutral Sentiment Momentum Backtest
 *
 * Strategy: Long top sentiment coins + Short bottom sentiment coins.
 * Equal dollar allocation per side → net market exposure ≈ 0.
 * Rebalance every N hours based on updated sentiment rankings.
 *
 * Usage: npx tsx backtest/market-neutral-runner.ts
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { SentimentSnapshot } from '../src/sentiment/types';
import { rankBySentiment, selectMarketNeutralLegs } from '../src/sentiment/aggregator';
import { generateSentimentSnapshots, SimulatedSentimentData } from './sentiment-simulator';
import { shouldExecuteSentimentSignal } from '../src/trading/strategies/market-neutral-filter';
import { calculatePositionSize } from '../src/trading/risk';
import { Trade, EquityPoint, calculateMetrics, printReport } from './metrics';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, 'data');

// ==========================================
// CONFIGURATION
// ==========================================
const CONFIG = {
  symbols: [
    'BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT',
    'DOGEUSDT', 'ADAUSDT', 'AVAXUSDT', 'DOTUSDT', 'LINKUSDT',
  ],
  interval: '1h',

  // Account
  initialBalance: 10_000,
  leverage: 3,
  riskPerTrade: 1.5,       // % per single leg

  // Portfolio construction
  allocationPerSide: 1500,  // $1500 long + $1500 short
  longsPerSide: 3,
  shortsPerSide: 3,
  rebalanceEveryHours: 4,

  // Sentiment thresholds
  minSentimentScore: 0.15,  // minimum |score| to consider

  // Fees
  makerFee: 0.0002,
  takerFee: 0.0004,
  slippagePercent: 0.0005,

  // Risk
  maxPositionSizeUsdt: 1000,
  slMultiplier: 2.0,        // ATR multiplier for SL
  tpMultiplier: 3.0,        // ATR multiplier for TP

  // Backtest
  windowSize: 48,            // 48 hourly candles = 2 days for indicators
  warmupCandles: 50,
};

interface OpenLeg {
  symbol: string;
  direction: 'LONG' | 'SHORT';
  sentimentScore: number;
  entryPrice: number;
  quantity: number; // USDT
  stopLoss: number;
  takeProfit: number;
  entryTime: number;
}

function loadData(): SimulatedSentimentData {
  // Load Fear & Greed
  const fgPath = join(DATA_DIR, 'fear_greed.json');
  if (!existsSync(fgPath)) {
    console.error('Fear & Greed data not found. Run: npm run backtest:fetch-sentiment');
    process.exit(1);
  }
  const fearGreed = JSON.parse(readFileSync(fgPath, 'utf-8'));

  // Load klines for all symbols
  const symbolKlines = new Map<string, number[][]>();
  for (const symbol of CONFIG.symbols) {
    const path = join(DATA_DIR, `${symbol}_${CONFIG.interval}.json`);
    if (!existsSync(path)) {
      console.warn(`  ${symbol}: data not found, skipping`);
      continue;
    }
    const klines = JSON.parse(readFileSync(path, 'utf-8'));
    symbolKlines.set(symbol, klines);
    console.log(`  ${symbol}: ${klines.length} candles`);
  }

  return { fearGreed, symbolKlines };
}

function runBacktest() {
  console.log('=== MARKET NEUTRAL SENTIMENT BACKTEST ===');
  console.log(`Symbols: ${CONFIG.symbols.length}`);
  console.log(`Allocation: $${CONFIG.allocationPerSide}/side`);
  console.log(`Rebalance: every ${CONFIG.rebalanceEveryHours}h`);
  console.log(`Leverage: ${CONFIG.leverage}x\n`);

  const data = loadData();
  const availableSymbols = CONFIG.symbols.filter((s) => data.symbolKlines.has(s));
  console.log(`\nAvailable symbols: ${availableSymbols.length}`);

  if (availableSymbols.length < 6) {
    console.error('Need at least 6 symbols for market-neutral (3 long + 3 short)');
    process.exit(1);
  }

  // Find common time range
  const minLength = Math.min(
    ...availableSymbols.map((s) => data.symbolKlines.get(s)!.length)
  );
  console.log(`Common candles: ${minLength}`);

  let balance = CONFIG.initialBalance;
  const trades: Trade[] = [];
  const equityCurve: EquityPoint[] = [];
  let openLegs: OpenLeg[] = [];
  let rebalanceCounter = 0;
  let totalLongPnl = 0;
  let totalShortPnl = 0;

  // Walk through candles
  for (let i = CONFIG.windowSize + CONFIG.warmupCandles; i < minLength; i++) {
    const refKlines = data.symbolKlines.get(availableSymbols[0])!;
    const timestamp = refKlines[i][0] as number;

    // --- Check SL/TP for open legs ---
    for (let p = openLegs.length - 1; p >= 0; p--) {
      const leg = openLegs[p];
      const klines = data.symbolKlines.get(leg.symbol)!;
      const candle = klines[i];
      const high = parseFloat(candle[2] as unknown as string);
      const low = parseFloat(candle[3] as unknown as string);

      let exitPrice = 0;
      let exitReason: 'SL' | 'TP' | 'SIGNAL' = 'SL';

      if (leg.direction === 'LONG') {
        if (low <= leg.stopLoss) { exitPrice = leg.stopLoss; exitReason = 'SL'; }
        else if (high >= leg.takeProfit) { exitPrice = leg.takeProfit; exitReason = 'TP'; }
      } else {
        if (high >= leg.stopLoss) { exitPrice = leg.stopLoss; exitReason = 'SL'; }
        else if (low <= leg.takeProfit) { exitPrice = leg.takeProfit; exitReason = 'TP'; }
      }

      if (exitPrice > 0) {
        const slip = exitPrice * CONFIG.slippagePercent;
        if (leg.direction === 'LONG') exitPrice -= slip;
        else exitPrice += slip;

        const rawPnl = leg.direction === 'LONG'
          ? (exitPrice - leg.entryPrice) * (leg.quantity / leg.entryPrice)
          : (leg.entryPrice - exitPrice) * (leg.quantity / leg.entryPrice);

        const fees = leg.quantity * (CONFIG.makerFee + CONFIG.takerFee);
        const pnl = rawPnl - fees;
        balance += pnl;

        if (leg.direction === 'LONG') totalLongPnl += pnl;
        else totalShortPnl += pnl;

        trades.push({
          symbol: leg.symbol,
          direction: leg.direction,
          entryPrice: leg.entryPrice,
          exitPrice,
          quantity: leg.quantity,
          pnl,
          pnlPercent: (pnl / leg.quantity) * 100,
          entryTime: leg.entryTime,
          exitTime: timestamp,
          exitReason,
        });

        openLegs.splice(p, 1);
      }
    }

    // --- Record equity ---
    const unrealized = openLegs.reduce((sum, leg) => {
      const klines = data.symbolKlines.get(leg.symbol)!;
      const close = parseFloat(klines[i][4] as unknown as string);
      return sum + (leg.direction === 'LONG'
        ? (close - leg.entryPrice) * (leg.quantity / leg.entryPrice)
        : (leg.entryPrice - close) * (leg.quantity / leg.entryPrice));
    }, 0);

    equityCurve.push({ timestamp, balance: balance + unrealized, drawdown: 0 });

    // --- Rebalance every N hours ---
    rebalanceCounter++;
    if (rebalanceCounter < CONFIG.rebalanceEveryHours) continue;
    rebalanceCounter = 0;

    // Generate sentiment snapshots for all symbols
    const snapshots = generateSentimentSnapshots(
      data, availableSymbols, timestamp, CONFIG.windowSize
    );

    if (snapshots.length < 6) continue;

    // Rank and select legs
    const ranked = rankBySentiment(snapshots);
    const { longs, shorts } = selectMarketNeutralLegs(
      ranked,
      CONFIG.longsPerSide,
      CONFIG.shortsPerSide,
      CONFIG.minSentimentScore
    );

    // Close legs that are no longer in the selection
    const newLongSymbols = new Set(longs.map((s) => s.asset + 'USDT'));
    const newShortSymbols = new Set(shorts.map((s) => s.asset + 'USDT'));

    for (let p = openLegs.length - 1; p >= 0; p--) {
      const leg = openLegs[p];
      const shouldKeep =
        (leg.direction === 'LONG' && newLongSymbols.has(leg.symbol)) ||
        (leg.direction === 'SHORT' && newShortSymbols.has(leg.symbol));

      if (!shouldKeep) {
        // Close this leg
        const klines = data.symbolKlines.get(leg.symbol)!;
        const exitPrice = parseFloat(klines[i][4] as unknown as string);
        const rawPnl = leg.direction === 'LONG'
          ? (exitPrice - leg.entryPrice) * (leg.quantity / leg.entryPrice)
          : (leg.entryPrice - exitPrice) * (leg.quantity / leg.entryPrice);
        const fees = leg.quantity * (CONFIG.makerFee + CONFIG.takerFee);
        const pnl = rawPnl - fees;
        balance += pnl;

        if (leg.direction === 'LONG') totalLongPnl += pnl;
        else totalShortPnl += pnl;

        trades.push({
          symbol: leg.symbol,
          direction: leg.direction,
          entryPrice: leg.entryPrice,
          exitPrice,
          quantity: leg.quantity,
          pnl,
          pnlPercent: (pnl / leg.quantity) * 100,
          entryTime: leg.entryTime,
          exitTime: timestamp,
          exitReason: 'SIGNAL',
        });

        openLegs.splice(p, 1);
      }
    }

    // Open new legs
    const perLegAllocation = CONFIG.allocationPerSide / CONFIG.longsPerSide;

    for (const snap of longs) {
      const symbol = snap.asset + 'USDT';
      if (openLegs.some((l) => l.symbol === symbol && l.direction === 'LONG')) continue;

      const klines = data.symbolKlines.get(symbol);
      if (!klines) continue;

      const window = klines.slice(i - CONFIG.windowSize, i);
      const highs = window.map((k) => parseFloat(k[2] as unknown as string));
      const lowsArr = window.map((k) => parseFloat(k[3] as unknown as string));
      const closes = window.map((k) => parseFloat(k[4] as unknown as string));
      const volumes = window.map((k) => parseFloat(k[5] as unknown as string));
      const currentPrice = closes[closes.length - 1];

      // Quant filter
      const filter = shouldExecuteSentimentSignal(
        snap, highs, lowsArr, closes, volumes, currentPrice, 'LONG'
      );

      if (!filter.approved) continue;

      const posSize = Math.min(perLegAllocation, CONFIG.maxPositionSizeUsdt);

      openLegs.push({
        symbol,
        direction: 'LONG',
        sentimentScore: snap.compositeScore,
        entryPrice: currentPrice * (1 + CONFIG.slippagePercent),
        quantity: posSize,
        stopLoss: filter.stopLoss,
        takeProfit: filter.takeProfit,
        entryTime: timestamp,
      });
    }

    for (const snap of shorts) {
      const symbol = snap.asset + 'USDT';
      if (openLegs.some((l) => l.symbol === symbol && l.direction === 'SHORT')) continue;

      const klines = data.symbolKlines.get(symbol);
      if (!klines) continue;

      const window = klines.slice(i - CONFIG.windowSize, i);
      const highs = window.map((k) => parseFloat(k[2] as unknown as string));
      const lowsArr = window.map((k) => parseFloat(k[3] as unknown as string));
      const closes = window.map((k) => parseFloat(k[4] as unknown as string));
      const volumes = window.map((k) => parseFloat(k[5] as unknown as string));
      const currentPrice = closes[closes.length - 1];

      const filter = shouldExecuteSentimentSignal(
        snap, highs, lowsArr, closes, volumes, currentPrice, 'SHORT'
      );

      if (!filter.approved) continue;

      const posSize = Math.min(perLegAllocation, CONFIG.maxPositionSizeUsdt);

      openLegs.push({
        symbol,
        direction: 'SHORT',
        sentimentScore: snap.compositeScore,
        entryPrice: currentPrice * (1 - CONFIG.slippagePercent),
        quantity: posSize,
        stopLoss: filter.stopLoss,
        takeProfit: filter.takeProfit,
        entryTime: timestamp,
      });
    }
  }

  // Close remaining positions
  for (const leg of openLegs) {
    const klines = data.symbolKlines.get(leg.symbol)!;
    const exitPrice = parseFloat(klines[minLength - 1][4] as unknown as string);
    const rawPnl = leg.direction === 'LONG'
      ? (exitPrice - leg.entryPrice) * (leg.quantity / leg.entryPrice)
      : (leg.entryPrice - exitPrice) * (leg.quantity / leg.entryPrice);
    const fees = leg.quantity * (CONFIG.makerFee + CONFIG.takerFee);
    const pnl = rawPnl - fees;
    balance += pnl;
    if (leg.direction === 'LONG') totalLongPnl += pnl;
    else totalShortPnl += pnl;

    trades.push({
      symbol: leg.symbol, direction: leg.direction,
      entryPrice: leg.entryPrice, exitPrice,
      quantity: leg.quantity, pnl,
      pnlPercent: (pnl / leg.quantity) * 100,
      entryTime: leg.entryTime,
      exitTime: Date.now(),
      exitReason: 'SIGNAL',
    });
  }

  // Print results
  const metrics = calculateMetrics(trades, CONFIG.initialBalance, equityCurve);
  printReport(metrics, CONFIG.initialBalance);

  // Market-neutral specific stats
  const longTrades = trades.filter((t) => t.direction === 'LONG');
  const shortTrades = trades.filter((t) => t.direction === 'SHORT');

  console.log('\n--- MARKET NEUTRAL STATS ---');
  console.log(`  Long P&L:  ${totalLongPnl >= 0 ? '+' : ''}$${totalLongPnl.toFixed(2)} (${longTrades.length} trades)`);
  console.log(`  Short P&L: ${totalShortPnl >= 0 ? '+' : ''}$${totalShortPnl.toFixed(2)} (${shortTrades.length} trades)`);
  console.log(`  Net P&L:   ${(totalLongPnl + totalShortPnl) >= 0 ? '+' : ''}$${(totalLongPnl + totalShortPnl).toFixed(2)}`);

  const longWinRate = longTrades.length > 0
    ? (longTrades.filter((t) => t.pnl > 0).length / longTrades.length * 100) : 0;
  const shortWinRate = shortTrades.length > 0
    ? (shortTrades.filter((t) => t.pnl > 0).length / shortTrades.length * 100) : 0;
  console.log(`  Long Win Rate:  ${longWinRate.toFixed(1)}%`);
  console.log(`  Short Win Rate: ${shortWinRate.toFixed(1)}%`);

  // By symbol
  console.log('\n--- BY SYMBOL ---');
  for (const symbol of CONFIG.symbols) {
    const st = trades.filter((t) => t.symbol === symbol);
    if (st.length === 0) continue;
    const sp = st.reduce((s, t) => s + t.pnl, 0);
    const sw = st.filter((t) => t.pnl > 0).length;
    console.log(
      `  ${symbol.padEnd(10)} ${String(st.length).padStart(4)} trades  ` +
      `${(sw / st.length * 100).toFixed(0).padStart(3)}% win  ` +
      `${sp >= 0 ? '+' : ''}$${sp.toFixed(2)}`
    );
  }

  // Exit reasons
  console.log('\n--- EXIT REASONS ---');
  const sl = trades.filter((t) => t.exitReason === 'SL');
  const tp = trades.filter((t) => t.exitReason === 'TP');
  const sig = trades.filter((t) => t.exitReason === 'SIGNAL');
  console.log(`  SL hit:      ${sl.length} (${(sl.length / trades.length * 100).toFixed(1)}%)`);
  console.log(`  TP hit:      ${tp.length} (${(tp.length / trades.length * 100).toFixed(1)}%)`);
  console.log(`  Rebalance:   ${sig.length} (${(sig.length / trades.length * 100).toFixed(1)}%)`);
}

runBacktest();
