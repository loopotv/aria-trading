import { describe, it, expect } from "vitest";
import {
  evaluateSlowTrail,
  SLOWTRAIL_ARM_MS,
  SLOWTRAIL_GIVEBACK,
  SLOWTRAIL_DEADLINE_MS,
  isCatastrophicLoss,
  type SlowTrailState,
} from "../src/trading/exits/slowtrail";

const T0 = 1_750_000_000_000;
const H = 3600_000;

function mkLong(over: Partial<SlowTrailState> = {}): SlowTrailState {
  return {
    direction: "LONG",
    entryPrice: 100,
    openedAt: T0,
    stopLoss: 96, // full regime-ATR stop
    bestClose: 100,
    ...over,
  };
}

function mkShort(over: Partial<SlowTrailState> = {}): SlowTrailState {
  return {
    direction: "SHORT",
    entryPrice: 100,
    openedAt: T0,
    stopLoss: 104, // full stop ABOVE price for shorts
    bestClose: 100,
    ...over,
  };
}

describe("evaluateSlowTrail — patience phase (<6h)", () => {
  it("LONG: no trail before 6h even with a big favorable move", () => {
    const d = evaluateSlowTrail(mkLong(), 110, T0 + 2 * H);
    expect(d.action).toBe("none");
    expect(d.bestClose).toBe(110); // peak still tracked
  });

  it("SHORT: no trail before 6h even with a big favorable move", () => {
    const d = evaluateSlowTrail(mkShort(), 90, T0 + 2 * H);
    expect(d.action).toBe("none");
    expect(d.bestClose).toBe(90);
  });

  it("arms exactly at 6h", () => {
    const d = evaluateSlowTrail(mkLong({ bestClose: 110 }), 110, T0 + SLOWTRAIL_ARM_MS);
    expect(d.action).toBe("ratchet");
  });
});

describe("evaluateSlowTrail — trail math", () => {
  it("LONG: stop = bestClose - 2% of peak", () => {
    // entry 100, bestClose 110 → peak 10 → stop = 110 - 0.2 = 109.8
    const d = evaluateSlowTrail(mkLong({ bestClose: 110 }), 109, T0 + 7 * H);
    expect(d.action).toBe("close_market"); // 109 < 109.8 → already through
    const d2 = evaluateSlowTrail(mkLong({ bestClose: 110 }), 109.9, T0 + 7 * H);
    expect(d2.action).toBe("ratchet");
    expect(d2.newStop).toBeCloseTo(110 - SLOWTRAIL_GIVEBACK * 10, 10);
  });

  it("SHORT: stop = bestClose + 2% of peak (mirrored)", () => {
    // entry 100, bestClose 90 → peak 10 → stop = 90 + 0.2 = 90.2
    const d = evaluateSlowTrail(mkShort({ bestClose: 90 }), 90.1, T0 + 7 * H);
    expect(d.action).toBe("ratchet");
    expect(d.newStop).toBeCloseTo(90 + SLOWTRAIL_GIVEBACK * 10, 10);
  });

  it("no trail with zero/negative favorable excursion (full SL keeps protecting)", () => {
    const d = evaluateSlowTrail(mkLong(), 97, T0 + 8 * H);
    expect(d.action).toBe("none");
    expect(d.reason).toContain("no favorable excursion");
    const ds = evaluateSlowTrail(mkShort(), 103, T0 + 8 * H);
    expect(ds.action).toBe("none");
  });

  it("bestClose is monotone per direction", () => {
    const dLong = evaluateSlowTrail(mkLong({ bestClose: 110 }), 105, T0 + 7 * H);
    expect(dLong.bestClose).toBe(110); // does not regress on pullback
    const dShort = evaluateSlowTrail(mkShort({ bestClose: 90 }), 95, T0 + 7 * H);
    expect(dShort.bestClose).toBe(90);
  });
});

describe("evaluateSlowTrail — ratchet-only", () => {
  it("LONG: never loosens an already-tighter stop", () => {
    // stop already ratcheted to 109.9; candidate 109.8 is looser → none
    const d = evaluateSlowTrail(
      mkLong({ bestClose: 110, stopLoss: 109.9 }),
      109.95,
      T0 + 8 * H,
    );
    expect(d.action).toBe("none");
    expect(d.reason).toContain("not tighter");
  });

  it("SHORT: never loosens an already-tighter stop", () => {
    const d = evaluateSlowTrail(
      mkShort({ bestClose: 90, stopLoss: 90.1 }),
      90.05,
      T0 + 8 * H,
    );
    expect(d.action).toBe("none");
  });
});

describe("evaluateSlowTrail — production-faithful clamp (no phantom fills)", () => {
  it("LONG: candidate stop at/above current price → close at market", () => {
    // bestClose 110, candidate 109.8, price fell to 109.5 → market close
    const d = evaluateSlowTrail(mkLong({ bestClose: 110 }), 109.5, T0 + 7 * H);
    expect(d.action).toBe("close_market");
    expect(d.reason).toContain("reached");
  });

  it("SHORT: candidate stop at/below current price → close at market", () => {
    const d = evaluateSlowTrail(mkShort({ bestClose: 90 }), 90.5, T0 + 7 * H);
    expect(d.action).toBe("close_market");
  });

  it("exact touch counts as breached", () => {
    // candidate = 110 - 0.2 = 109.8 exactly at price
    const d = evaluateSlowTrail(mkLong({ bestClose: 110 }), 109.8, T0 + 7 * H);
    expect(d.action).toBe("close_market");
  });
});

describe("evaluateSlowTrail — 48h deadline", () => {
  it("closes at market at 48h even in profit", () => {
    const d = evaluateSlowTrail(mkLong({ bestClose: 115 }), 114, T0 + SLOWTRAIL_DEADLINE_MS);
    expect(d.action).toBe("close_market");
    expect(d.reason).toContain("deadline");
  });

  it("closes at market at 48h even underwater", () => {
    const d = evaluateSlowTrail(mkShort(), 101, T0 + SLOWTRAIL_DEADLINE_MS + H);
    expect(d.action).toBe("close_market");
  });

  it("does not close just before 48h", () => {
    const d = evaluateSlowTrail(mkLong(), 99, T0 + SLOWTRAIL_DEADLINE_MS - H);
    expect(d.action).toBe("none");
  });
});

describe("evaluateSlowTrail — post-deploy recovery semantics", () => {
  it("ratcheted stop persisted in D1 + bestClose reset to entry does not regress", () => {
    // After a deploy: bestClose restarts at entry, but stopLoss=109.9 was persisted.
    // Price at 109.95 → peak 9.95 → candidate ≈ 109.751 < 109.9 → none (no loosening).
    const d = evaluateSlowTrail(
      mkLong({ bestClose: 100, stopLoss: 109.9 }),
      109.95,
      T0 + 10 * H,
    );
    expect(d.action).toBe("none");
  });
});

describe('isCatastrophicLoss — circuit breaker', () => {
  // TIA SHORT real case: entry 0.3441, SL 0.3542 (slDist 0.0101). 1.5× = 0.01515.
  // Breaker should fire at price >= 0.3441 + 0.01515 = 0.35925.
  it('SHORT: fires when adverse >= 1.5x SL distance', () => {
    expect(isCatastrophicLoss('SHORT', 0.3441, 0.3599, 0.3542)).toBe(true);
    expect(isCatastrophicLoss('SHORT', 0.3441, 0.3700, 0.3542)).toBe(true); // the actual -1.12 fill
  });
  it('SHORT: does NOT fire below the multiple', () => {
    expect(isCatastrophicLoss('SHORT', 0.3441, 0.3550, 0.3542)).toBe(false); // just past SL, not yet 1.5x
    expect(isCatastrophicLoss('SHORT', 0.3441, 0.3400, 0.3542)).toBe(false); // in profit
  });
  it('LONG: mirror — fires when price drops 1.5x SL distance below entry', () => {
    // entry 100, SL 98 (slDist 2). 1.5x = 3 → fires at price <= 97.
    expect(isCatastrophicLoss('LONG', 100, 97, 98)).toBe(true);
    expect(isCatastrophicLoss('LONG', 100, 96.9, 98)).toBe(true);
    expect(isCatastrophicLoss('LONG', 100, 97.5, 98)).toBe(false);
    expect(isCatastrophicLoss('LONG', 100, 101, 98)).toBe(false); // in profit
  });
  it('exactly at the multiple → fires (>=)', () => {
    expect(isCatastrophicLoss('LONG', 100, 97, 98, 1.5)).toBe(true);
  });
  it('custom multiple respected', () => {
    expect(isCatastrophicLoss('LONG', 100, 96, 98, 2.0)).toBe(true);  // 2x = 4 → fires at <=96
    expect(isCatastrophicLoss('LONG', 100, 96.5, 98, 2.0)).toBe(false);
  });
  it('zero SL distance → never fires (guard)', () => {
    expect(isCatastrophicLoss('SHORT', 100, 200, 100)).toBe(false);
  });
});
