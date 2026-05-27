/**
 * Fluid Parameters — dynamic adaptation of RSI / Volume / Ticks thresholds
 * based on:
 *   1. Historical pattern win-rate in D1 (`patterns` table) for this
 *      asset+direction+regime — be lenient on proven setups, strict on losers.
 *   2. Current market volatility (ATR%) — fast markets confirm fewer ticks,
 *      slow markets need more.
 *
 * Imported as part of Step 2 hyper-trader integration on 2026-05-27. Hyper-
 * trader achieved 64.7% WR over 17 trades with this layer on top of
 * STRATEGY_DEFAULTS, vs upstream's static gates.
 *
 * The pattern lookup uses the existing `patterns` table that ARIA already
 * populates via experience.learnFromTrade() — no new schema needed.
 */

import { ExperienceDB } from './experience';
import { STRATEGY_DEFAULTS } from './strategy-defaults';

export interface FluidParams {
  optimalRSI: number;
  optimalADX: number;
  volumeRatio: number;
  fluidTicks: number;       // 1-4: how many cycles to wait for confirmation
  rsiDecayTolerance: number; // how much RSI can drop back before a setup dies
}

export async function computeFluidParams(
  expDb: ExperienceDB | null,
  symbol: string,
  direction: 'LONG' | 'SHORT',
  regime: string,
  currentAtrPct: number,
): Promise<FluidParams> {
  const baseRsi = STRATEGY_DEFAULTS.optimalRSI[direction];
  const baseVol = STRATEGY_DEFAULTS.volumeRatio[direction];

  let fluidRsi: number = baseRsi;
  let fluidVol: number = baseVol;

  if (expDb) {
    try {
      const patternName = `${symbol.replace('USDT', '')}_${direction}_${regime || 'unknown'}`;
      const pattern = await expDb.getDb()
        .prepare(`SELECT win_rate, successes FROM patterns WHERE name = ?`)
        .bind(patternName)
        .first<{ win_rate: number, successes: number }>();

      // Need at least 3 historical trades to trust the pattern
      if (pattern && pattern.successes >= 3) {
        if (pattern.win_rate > 0.6) {
          // Proven winner: be lenient (-3 RSI, -10% vol)
          fluidRsi = baseRsi - 3;
          fluidVol = baseVol * 0.9;
        } else if (pattern.win_rate < 0.4) {
          // Proven loser: be stricter (+3 RSI, +20% vol)
          fluidRsi = baseRsi + 3;
          fluidVol = baseVol * 1.2;
        }
      }
    } catch {
      // DB errors fall through to base defaults
    }
  }

  // Clamps prevent runaway tuning
  fluidRsi = Math.max(STRATEGY_DEFAULTS.fluidRsiClamp.min,
                       Math.min(STRATEGY_DEFAULTS.fluidRsiClamp.max, fluidRsi));
  fluidVol = Math.max(STRATEGY_DEFAULTS.fluidVolClamp.min,
                       Math.min(STRATEGY_DEFAULTS.fluidVolClamp.max, fluidVol));

  // Fluid ticks: wait fewer confirmations in fast markets (volatility = price moves
  // quickly anyway, no need for multi-tick confirmation), more in slow markets.
  let fluidTicks: number;
  if (currentAtrPct > 2.5) fluidTicks = 1;
  else if (currentAtrPct > 1.5) fluidTicks = 2;
  else if (currentAtrPct > 0.8) fluidTicks = 3;
  else fluidTicks = 4;

  // RSI decay tolerance: how much RSI is allowed to bounce back against us
  // before the setup is dead. Tighter in fast markets (3), looser in slow (6).
  const rsiDecayTolerance = currentAtrPct > 2.0 ? 3 : 6;

  return {
    optimalRSI: fluidRsi,
    optimalADX: STRATEGY_DEFAULTS.optimalADX,
    volumeRatio: fluidVol,
    fluidTicks,
    rsiDecayTolerance,
  };
}
