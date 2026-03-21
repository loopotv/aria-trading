/**
 * Trading performance metrics calculator.
 * Pure math - no dependencies.
 */

export interface Trade {
  symbol: string;
  direction: 'LONG' | 'SHORT';
  entryPrice: number;
  exitPrice: number;
  quantity: number; // in USDT
  pnl: number;
  pnlPercent: number;
  entryTime: number;
  exitTime: number;
  exitReason: 'SL' | 'TP' | 'SIGNAL';
}

export interface EquityPoint {
  timestamp: number;
  balance: number;
  drawdown: number;
}

export interface BacktestMetrics {
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  winRate: number;
  totalPnl: number;
  totalPnlPercent: number;
  avgWin: number;
  avgLoss: number;
  avgRR: number;
  profitFactor: number;
  maxDrawdown: number;
  maxDrawdownPercent: number;
  sharpeRatio: number;
  sortinoRatio: number;
  calmarRatio: number;
  avgTradeDuration: number; // in hours
  longestWinStreak: number;
  longestLoseStreak: number;
  finalBalance: number;
}

export function calculateMetrics(
  trades: Trade[],
  initialBalance: number,
  equityCurve: EquityPoint[]
): BacktestMetrics {
  if (trades.length === 0) {
    return emptyMetrics(initialBalance);
  }

  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl <= 0);

  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
  const grossWins = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLosses = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));

  // Win/Lose streaks
  let currentStreak = 0;
  let longestWinStreak = 0;
  let longestLoseStreak = 0;
  let isWinning = false;

  for (const t of trades) {
    if (t.pnl > 0) {
      if (isWinning) currentStreak++;
      else { currentStreak = 1; isWinning = true; }
      longestWinStreak = Math.max(longestWinStreak, currentStreak);
    } else {
      if (!isWinning) currentStreak++;
      else { currentStreak = 1; isWinning = false; }
      longestLoseStreak = Math.max(longestLoseStreak, currentStreak);
    }
  }

  // Max drawdown from equity curve
  let peak = initialBalance;
  let maxDrawdown = 0;
  let maxDrawdownPercent = 0;

  for (const point of equityCurve) {
    if (point.balance > peak) peak = point.balance;
    const dd = peak - point.balance;
    const ddPct = peak > 0 ? dd / peak : 0;
    if (dd > maxDrawdown) maxDrawdown = dd;
    if (ddPct > maxDrawdownPercent) maxDrawdownPercent = ddPct;
  }

  // Daily returns for Sharpe/Sortino
  const dailyReturns = calculateDailyReturns(equityCurve);
  const sharpeRatio = calculateSharpe(dailyReturns);
  const sortinoRatio = calculateSortino(dailyReturns);

  // Annualized return for Calmar
  const totalDays = equityCurve.length > 1
    ? (equityCurve[equityCurve.length - 1].timestamp - equityCurve[0].timestamp) / (24 * 60 * 60 * 1000)
    : 1;
  const annualizedReturn = totalDays > 0
    ? (totalPnl / initialBalance) * (365 / totalDays)
    : 0;
  const calmarRatio = maxDrawdownPercent > 0
    ? annualizedReturn / maxDrawdownPercent
    : 0;

  // Avg trade duration
  const durations = trades.map((t) => (t.exitTime - t.entryTime) / (1000 * 60 * 60));
  const avgTradeDuration = durations.reduce((a, b) => a + b, 0) / durations.length;

  return {
    totalTrades: trades.length,
    winningTrades: wins.length,
    losingTrades: losses.length,
    winRate: (wins.length / trades.length) * 100,
    totalPnl,
    totalPnlPercent: (totalPnl / initialBalance) * 100,
    avgWin: wins.length > 0 ? grossWins / wins.length : 0,
    avgLoss: losses.length > 0 ? grossLosses / losses.length : 0,
    avgRR: losses.length > 0 && grossLosses > 0
      ? (grossWins / wins.length) / (grossLosses / losses.length)
      : 0,
    profitFactor: grossLosses > 0 ? grossWins / grossLosses : grossWins > 0 ? Infinity : 0,
    maxDrawdown,
    maxDrawdownPercent: maxDrawdownPercent * 100,
    sharpeRatio,
    sortinoRatio,
    calmarRatio,
    avgTradeDuration,
    longestWinStreak,
    longestLoseStreak,
    finalBalance: initialBalance + totalPnl,
  };
}

function calculateDailyReturns(equityCurve: EquityPoint[]): number[] {
  if (equityCurve.length < 2) return [];

  const dailyBalances = new Map<string, number>();

  for (const point of equityCurve) {
    const day = new Date(point.timestamp).toISOString().split('T')[0];
    dailyBalances.set(day, point.balance);
  }

  const days = Array.from(dailyBalances.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  const returns: number[] = [];

  for (let i = 1; i < days.length; i++) {
    const prev = days[i - 1][1];
    if (prev > 0) {
      returns.push((days[i][1] - prev) / prev);
    }
  }

  return returns;
}

function calculateSharpe(dailyReturns: number[]): number {
  if (dailyReturns.length < 2) return 0;
  const mean = dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length;
  const variance = dailyReturns.reduce((s, r) => s + (r - mean) ** 2, 0) / (dailyReturns.length - 1);
  const std = Math.sqrt(variance);
  if (std === 0) return 0;
  return (mean / std) * Math.sqrt(365); // annualized
}

function calculateSortino(dailyReturns: number[]): number {
  if (dailyReturns.length < 2) return 0;
  const mean = dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length;
  const downside = dailyReturns.filter((r) => r < 0);
  if (downside.length === 0) return mean > 0 ? Infinity : 0;
  const downsideVariance = downside.reduce((s, r) => s + r ** 2, 0) / downside.length;
  const downsideStd = Math.sqrt(downsideVariance);
  if (downsideStd === 0) return 0;
  return (mean / downsideStd) * Math.sqrt(365);
}

function emptyMetrics(initialBalance: number): BacktestMetrics {
  return {
    totalTrades: 0, winningTrades: 0, losingTrades: 0, winRate: 0,
    totalPnl: 0, totalPnlPercent: 0, avgWin: 0, avgLoss: 0, avgRR: 0,
    profitFactor: 0, maxDrawdown: 0, maxDrawdownPercent: 0,
    sharpeRatio: 0, sortinoRatio: 0, calmarRatio: 0,
    avgTradeDuration: 0, longestWinStreak: 0, longestLoseStreak: 0,
    finalBalance: initialBalance,
  };
}

export function printReport(metrics: BacktestMetrics, initialBalance: number) {
  const g = metrics.totalPnl >= 0 ? '+' : '';

  console.log('\n╔══════════════════════════════════════════╗');
  console.log('║         BACKTEST RESULTS                  ║');
  console.log('╠══════════════════════════════════════════╣');
  console.log(`║  Initial Balance:    $${initialBalance.toFixed(2).padStart(12)}`);
  console.log(`║  Final Balance:      $${metrics.finalBalance.toFixed(2).padStart(12)}`);
  console.log(`║  Total P&L:         ${g}$${metrics.totalPnl.toFixed(2).padStart(12)}  (${g}${metrics.totalPnlPercent.toFixed(1)}%)`);
  console.log('╠══════════════════════════════════════════╣');
  console.log(`║  Total Trades:       ${String(metrics.totalTrades).padStart(8)}`);
  console.log(`║  Win Rate:           ${metrics.winRate.toFixed(1).padStart(7)}%`);
  console.log(`║  Avg Win:           $${metrics.avgWin.toFixed(2).padStart(8)}`);
  console.log(`║  Avg Loss:          $${metrics.avgLoss.toFixed(2).padStart(8)}`);
  console.log(`║  Avg R:R:            ${metrics.avgRR.toFixed(2).padStart(8)}`);
  console.log(`║  Profit Factor:      ${metrics.profitFactor === Infinity ? '     Inf' : metrics.profitFactor.toFixed(2).padStart(8)}`);
  console.log('╠══════════════════════════════════════════╣');
  console.log(`║  Sharpe Ratio:       ${metrics.sharpeRatio.toFixed(2).padStart(8)}  ${metrics.sharpeRatio >= 1 ? '✓' : '✗'}`);
  console.log(`║  Sortino Ratio:      ${metrics.sortinoRatio.toFixed(2).padStart(8)}`);
  console.log(`║  Calmar Ratio:       ${metrics.calmarRatio.toFixed(2).padStart(8)}`);
  console.log(`║  Max Drawdown:      $${metrics.maxDrawdown.toFixed(2).padStart(8)}  (${metrics.maxDrawdownPercent.toFixed(1)}%)`);
  console.log('╠══════════════════════════════════════════╣');
  console.log(`║  Avg Trade Duration: ${metrics.avgTradeDuration.toFixed(1).padStart(7)}h`);
  console.log(`║  Win Streak:         ${String(metrics.longestWinStreak).padStart(8)}`);
  console.log(`║  Lose Streak:        ${String(metrics.longestLoseStreak).padStart(8)}`);
  console.log('╚══════════════════════════════════════════╝');

  // Pass/Fail gate
  console.log('\n--- EXIT CRITERIA ---');
  const checks = [
    { name: 'Trades >= 500', pass: metrics.totalTrades >= 500 },
    { name: 'Sharpe >= 1.0', pass: metrics.sharpeRatio >= 1.0 },
    { name: 'Max DD < 20%', pass: metrics.maxDrawdownPercent < 20 },
    { name: 'Profit Factor > 1.3', pass: metrics.profitFactor > 1.3 },
  ];

  for (const c of checks) {
    console.log(`  ${c.pass ? '✓' : '✗'} ${c.name}`);
  }

  const allPass = checks.every((c) => c.pass);
  console.log(`\n${allPass ? '>>> PASS - Ready for Phase 2 (Testnet)' : '>>> FAIL - Tune strategy before proceeding'}`);
}
