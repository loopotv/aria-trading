/**
 * Backtesting engine - simulates the trading pipeline on historical data.
 * Uses the same indicators and signals as the production bot.
 *
 * Usage: npx tsx backtest/runner.ts
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { generateSignal } from '../src/trading/signals';
import { calculatePositionSize } from '../src/trading/risk';
import { Trade, EquityPoint, calculateMetrics, printReport } from './metrics';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, 'data');

// ==========================================
// BACKTEST CONFIGURATION
// ==========================================
const CONFIG = {
  symbols: ['BTCUSDT', 'ETHUSDT'],
  interval: '15m',

  // Account
  initialBalance: 10_000,
  leverage: 5,
  riskPerTrade: 2, // % of balance per trade

  // Signal thresholds (high selectivity = fewer but better trades)
  minSignalStrength: 0.6,

  // Position limits
  maxPositions: 3,
  maxPositionSizeUsdt: 2_000,

  // Fees (Binance Futures)
  makerFee: 0.0002,  // 0.02% for LIMIT entry
  takerFee: 0.0004,  // 0.04% for MARKET exit (SL/TP)

  // Slippage estimate
  slippagePercent: 0.0005, // 0.05%

  // Backtest settings
  windowSize: 100,   // candles per signal calculation (same as production)
  warmupCandles: 50,  // skip first N candles for indicator stability
};

interface OpenPosition {
  symbol: string;
  direction: 'LONG' | 'SHORT';
  entryPrice: number;
  quantity: number; // USDT size
  stopLoss: number;
  takeProfit: number;
  entryTime: number;
}

interface SymbolData {
  symbol: string;
  klines: number[][]; // raw kline arrays
}

function loadData(): SymbolData[] {
  const data: SymbolData[] = [];

  for (const symbol of CONFIG.symbols) {
    const filePath = join(DATA_DIR, `${symbol}_${CONFIG.interval}.json`);
    if (!existsSync(filePath)) {
      console.error(`Data file not found: ${filePath}`);
      console.error('Run "npm run backtest:fetch" first to download historical data.');
      process.exit(1);
    }
    const raw = JSON.parse(readFileSync(filePath, 'utf-8')) as number[][];
    data.push({ symbol, klines: raw });
    console.log(`Loaded ${symbol}: ${raw.length} candles`);
  }

  return data;
}

function runBacktest() {
  console.log('=== BACKTEST ENGINE ===');
  console.log(`Config: ${JSON.stringify({
    symbols: CONFIG.symbols,
    balance: CONFIG.initialBalance,
    leverage: CONFIG.leverage,
    risk: `${CONFIG.riskPerTrade}%`,
    minStrength: CONFIG.minSignalStrength,
  })}\n`);

  const symbolData = loadData();

  let balance = CONFIG.initialBalance;
  const trades: Trade[] = [];
  const equityCurve: EquityPoint[] = [];
  const openPositions: OpenPosition[] = [];

  // Find the common time range across all symbols
  const maxLength = Math.min(...symbolData.map((d) => d.klines.length));
  console.log(`Common candles: ${maxLength}`);
  console.log(`Warm-up: ${CONFIG.warmupCandles} candles skipped\n`);

  // Walk through candles chronologically
  for (let i = CONFIG.windowSize; i < maxLength; i++) {
    const timestamp = symbolData[0].klines[i][0] as number;

    // --- Check SL/TP for open positions ---
    for (let p = openPositions.length - 1; p >= 0; p--) {
      const pos = openPositions[p];
      const sd = symbolData.find((d) => d.symbol === pos.symbol)!;
      const candle = sd.klines[i];
      const high = parseFloat(candle[2] as unknown as string);
      const low = parseFloat(candle[3] as unknown as string);

      let exitPrice = 0;
      let exitReason: 'SL' | 'TP' | 'SIGNAL' = 'SL';

      if (pos.direction === 'LONG') {
        // Check SL first (conservative: if both hit, assume SL)
        if (low <= pos.stopLoss) {
          exitPrice = pos.stopLoss;
          exitReason = 'SL';
        } else if (high >= pos.takeProfit) {
          exitPrice = pos.takeProfit;
          exitReason = 'TP';
        }
      } else {
        if (high >= pos.stopLoss) {
          exitPrice = pos.stopLoss;
          exitReason = 'SL';
        } else if (low <= pos.takeProfit) {
          exitPrice = pos.takeProfit;
          exitReason = 'TP';
        }
      }

      if (exitPrice > 0) {
        // Apply slippage on exit (MARKET order)
        const slippage = exitPrice * CONFIG.slippagePercent;
        if (pos.direction === 'LONG') {
          exitPrice -= slippage; // worse price for selling
        } else {
          exitPrice += slippage; // worse price for buying back
        }

        const rawPnl = pos.direction === 'LONG'
          ? (exitPrice - pos.entryPrice) * (pos.quantity / pos.entryPrice)
          : (pos.entryPrice - exitPrice) * (pos.quantity / pos.entryPrice);

        // Subtract fees: entry maker + exit taker
        const entryFee = pos.quantity * CONFIG.makerFee;
        const exitFee = pos.quantity * CONFIG.takerFee;
        const pnl = rawPnl - entryFee - exitFee;

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
    const unrealized = openPositions.reduce((sum, pos) => {
      const sd = symbolData.find((d) => d.symbol === pos.symbol)!;
      const currentClose = parseFloat(sd.klines[i][4] as unknown as string);
      if (pos.direction === 'LONG') {
        return sum + (currentClose - pos.entryPrice) * (pos.quantity / pos.entryPrice);
      } else {
        return sum + (pos.entryPrice - currentClose) * (pos.quantity / pos.entryPrice);
      }
    }, 0);

    equityCurve.push({
      timestamp,
      balance: balance + unrealized,
      drawdown: 0, // calculated in metrics
    });

    // --- Generate signals for each symbol ---
    if (i < CONFIG.windowSize + CONFIG.warmupCandles) continue; // warm-up

    for (const sd of symbolData) {
      // Skip if already have position on this symbol
      if (openPositions.some((p) => p.symbol === sd.symbol)) continue;
      // Skip if max positions reached
      if (openPositions.length >= CONFIG.maxPositions) continue;

      // Extract window
      const window = sd.klines.slice(i - CONFIG.windowSize, i);
      const highs = window.map((k) => parseFloat(k[2] as unknown as string));
      const lows = window.map((k) => parseFloat(k[3] as unknown as string));
      const closes = window.map((k) => parseFloat(k[4] as unknown as string));
      const volumes = window.map((k) => parseFloat(k[5] as unknown as string));
      const currentPrice = closes[closes.length - 1];

      // Generate signal (v2 with ADX regime + volume)
      const signal = generateSignal(highs, lows, closes, currentPrice, volumes);

      if (
        signal.action !== 'OPEN' ||
        signal.strength < CONFIG.minSignalStrength ||
        signal.direction === 'NEUTRAL'
      ) {
        continue;
      }

      // Calculate position size using risk manager
      const positionSize = calculatePositionSize(
        balance,
        CONFIG.riskPerTrade,
        currentPrice,
        signal.stopLoss,
        CONFIG.leverage,
        CONFIG.maxPositionSizeUsdt
      );

      if (positionSize <= 0) continue;

      // Apply entry slippage (LIMIT order - minimal but account for it)
      let entryPrice = currentPrice;
      if (signal.direction === 'LONG') {
        entryPrice *= (1 + CONFIG.slippagePercent);
      } else {
        entryPrice *= (1 - CONFIG.slippagePercent);
      }

      openPositions.push({
        symbol: sd.symbol,
        direction: signal.direction,
        entryPrice,
        quantity: positionSize,
        stopLoss: signal.stopLoss,
        takeProfit: signal.takeProfit,
        entryTime: timestamp,
      });
    }
  }

  // Close remaining positions at last price
  for (const pos of openPositions) {
    const sd = symbolData.find((d) => d.symbol === pos.symbol)!;
    const lastCandle = sd.klines[maxLength - 1];
    const exitPrice = parseFloat(lastCandle[4] as unknown as string);
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
      exitTime: symbolData[0].klines[maxLength - 1][0] as number,
      exitReason: 'SIGNAL',
    });
  }

  // Calculate and print metrics
  const metrics = calculateMetrics(trades, CONFIG.initialBalance, equityCurve);
  printReport(metrics, CONFIG.initialBalance);

  // Trade breakdown by symbol
  console.log('\n--- BY SYMBOL ---');
  for (const symbol of CONFIG.symbols) {
    const symbolTrades = trades.filter((t) => t.symbol === symbol);
    const symbolWins = symbolTrades.filter((t) => t.pnl > 0);
    const symbolPnl = symbolTrades.reduce((s, t) => s + t.pnl, 0);
    console.log(
      `  ${symbol}: ${symbolTrades.length} trades, ` +
      `${((symbolWins.length / (symbolTrades.length || 1)) * 100).toFixed(1)}% win rate, ` +
      `${symbolPnl >= 0 ? '+' : ''}$${symbolPnl.toFixed(2)} P&L`
    );
  }

  // Exit reason breakdown
  console.log('\n--- EXIT REASONS ---');
  const slTrades = trades.filter((t) => t.exitReason === 'SL');
  const tpTrades = trades.filter((t) => t.exitReason === 'TP');
  const sigTrades = trades.filter((t) => t.exitReason === 'SIGNAL');
  console.log(`  SL hit:     ${slTrades.length} (${((slTrades.length / trades.length) * 100).toFixed(1)}%)`);
  console.log(`  TP hit:     ${tpTrades.length} (${((tpTrades.length / trades.length) * 100).toFixed(1)}%)`);
  console.log(`  Signal/EOD: ${sigTrades.length} (${((sigTrades.length / trades.length) * 100).toFixed(1)}%)`);
}

runBacktest();
