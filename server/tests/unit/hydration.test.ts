import { describe, expect, it } from "vitest";

import { holdersFromSwaps, netPositions, rankHolders } from "@/lib/juno/activity";
import { feeScheduleOf, shapeOf, tokenomicsOf } from "@/lib/juno/chain";
import { rankTraders } from "@/lib/juno/leaderboard";
import { fullReserve } from "@/lib/juno/onchain";
import { changeWithin, priceSeries, toSwaps, totalVolume, volumeWithin, DAY_MS, type TradeRecord } from "@/lib/juno/swaps";

/**
 * The numbers a coin page shows, derived from recorded `Trade` rows.
 *
 * Rows are stored as integer strings in base units; everything below is what
 * the hydration layer makes of them.
 */

const NOW = Date.parse("2026-09-28T12:00:00Z");
const HOUR = 60 * 60 * 1000;
const E18 = 10n ** 18n;

function row(over: Partial<TradeRecord> & { blockNumber: number }): TradeRecord {
  return {
    txHash: `0x${over.blockNumber.toString(16).padStart(64, "0")}`,
    logIndex: 0,
    curve: "0xcurve",
    trader: "0xalice",
    isBuy: true,
    quoteAmount: (10n ** 16n).toString(), // 0.01 ETH
    tokenAmount: (1_000n * E18).toString(),
    feeCreator: "0",
    feeProtocol: "0",
    priceAfter: (20n * 10n ** 9n).toString(), // 2e-8 ETH per token
    soldAfter: "0",
    blockTime: new Date(NOW - HOUR),
    ...over,
  };
}

describe("toSwaps", () => {
  it("converts base units with the quote's decimals and sorts newest first", () => {
    const swaps = toSwaps(
      [
        row({ blockNumber: 1, quoteAmount: "5000000", priceAfter: "1500000" }),
        row({ blockNumber: 3, isBuy: false, quoteAmount: "2500000", tokenAmount: (1n * E18).toString() }),
      ],
      6,
    );
    expect(swaps.map((s) => s.blockNumber)).toEqual([3, 1]);
    expect(swaps[1]).toMatchObject({ side: "buy", quoteAmount: 5, baseAmount: 1000, price: 1.5 });
    expect(swaps[0]).toMatchObject({ side: "sell", quoteAmount: 2.5, baseAmount: 1 });
  });

  it("orders trades in one block by log index", () => {
    const swaps = toSwaps([row({ blockNumber: 7, logIndex: 1 }), row({ blockNumber: 7, logIndex: 4 })], 18);
    expect(swaps.map((s) => s.logIndex)).toEqual([4, 1]);
    expect(swaps[0].seq).toBeGreaterThan(swaps[1].seq);
  });

  it("can attribute a trader to someone else", () => {
    const [swap] = toSwaps([row({ blockNumber: 1, trader: "0xfactory" })], 18, new Map([["0xfactory", "0xcreator"]]));
    expect(swap.trader).toBe("0xcreator");
  });
});

describe("volume and change", () => {
  const swaps = toSwaps(
    [
      row({ blockNumber: 1, blockTime: new Date(NOW - 30 * HOUR), priceAfter: (10n * 10n ** 9n).toString() }),
      row({ blockNumber: 2, blockTime: new Date(NOW - 2 * HOUR), priceAfter: (15n * 10n ** 9n).toString() }),
      row({ blockNumber: 3, blockTime: new Date(NOW - HOUR), isBuy: false, quoteAmount: (3n * 10n ** 15n).toString() }),
    ],
    18,
  );

  it("sums quote volume inside the window only", () => {
    expect(volumeWithin(swaps, DAY_MS, NOW)).toBeCloseTo(0.013, 12);
    expect(totalVolume(swaps)).toBeCloseTo(0.023, 12);
  });

  it("measures the 24h change from the last trade before the window", () => {
    expect(changeWithin(swaps, DAY_MS, 2e-8, NOW)).toBeCloseTo(1, 10);
  });

  it("uses the opening price for a coin younger than the window", () => {
    const young = swaps.slice(0, 2);
    expect(changeWithin(young, DAY_MS, 3e-8, NOW, { price: 1e-8, at: NOW - 5 * HOUR })).toBeCloseTo(2, 10);
    expect(changeWithin([], DAY_MS, 3e-8, NOW)).toBeNull();
  });

  it("draws the chart oldest first from each trade's price after", () => {
    const series = priceSeries(swaps);
    expect(series.map((p) => p.price)).toEqual([1e-8, 1.5e-8, 2e-8]);
    expect(series[2].side).toBe("sell");
  });

  it("reports no history as null, not zero", () => {
    expect(volumeWithin([], DAY_MS, NOW)).toBeNull();
    expect(totalVolume([])).toBeNull();
  });
});

describe("holders", () => {
  it("nets buys against sells and drops wallets that sold out", () => {
    const swaps = toSwaps(
      [
        row({ blockNumber: 1, trader: "0xa", tokenAmount: (100n * E18).toString() }),
        row({ blockNumber: 2, trader: "0xa", isBuy: false, tokenAmount: (100n * E18).toString() }),
        row({ blockNumber: 3, trader: "0xb", tokenAmount: (30n * E18).toString() }),
        row({ blockNumber: 4, trader: "0xc", tokenAmount: (10n * E18).toString() }),
      ],
      18,
    );
    const holders = holdersFromSwaps(swaps);
    expect(holders.map((h) => [h.wallet, h.balance])).toEqual([
      ["0xb", 30],
      ["0xc", 10],
    ]);
    expect(holders[0].share).toBeCloseTo(0.75, 10);
    expect(netPositions(swaps).get("0xa")).toBe(0);
  });

  it("ranks a live balance map the same way", () => {
    const ranked = rankHolders(new Map([["0x1", 1], ["0x2", 3], ["0x3", 0]]));
    expect(ranked.map((h) => h.rank)).toEqual([1, 2]);
    expect(ranked[0].wallet).toBe("0x2");
  });
});

describe("curve maths from on-chain parameters", () => {
  // Two segments: 0→10 tokens at price 1→2, 10→30 tokens at price 2→4 (quote units per token, 6 decimals).
  const boundaries = { prices: [1_000_000n, 2_000_000n, 4_000_000n], sizes: [10n * E18, 20n * E18] };

  it("adds up what a full curve holds", () => {
    // 10 × 1.5 + 20 × 3 = 75 quote units.
    expect(fullReserve(boundaries)).toBe(75_000_000n);
  });

  it("describes the shape in whole units", () => {
    const shape = shapeOf(boundaries, 6, 3_000_000n);
    expect(shape.startPrice).toBe(1);
    expect(shape.endPrice).toBe(4);
    expect(shape.currentPrice).toBe(3);
    expect(shape.points.map((p) => [p.price, p.liquidity, p.weight])).toEqual([
      [1, 10, 0.5],
      [2, 20, 1],
    ]);
  });

  it("splits supply the way graduate() will", () => {
    const tokenomics = tokenomicsOf({ supply: 100n * E18, curveSupply: 30n * E18, graduationPrice: 4_000_000n }, 75_000_000n);
    // 75 quote at a price of 4 pairs with 18.75 tokens; the rest of the 70 burns.
    expect(tokenomics.migrationAmount).toBeCloseTo(18.75, 10);
    expect(tokenomics.leftoverAmount).toBeCloseTo(51.25, 10);
    expect(tokenomics.curvePct).toBeCloseTo(0.3, 10);
  });

  it("samples the fee decay from start to end", () => {
    const launchedAt = Math.floor(NOW / 1000) - 300;
    const schedule = feeScheduleOf({ feeStartBps: 900, feeEndBps: 100, feeDecaySeconds: 600 }, launchedAt, 164, Math.floor(NOW / 1000));
    expect(schedule.currentBps).toBe(164);
    expect(schedule.points[0].bps).toBe(900);
    expect(schedule.points[60].bps).toBeCloseTo(100 + 800 * Math.exp(-5), 1);
    expect(schedule.period).toBe(30);
    expect(schedule.secondsRemaining).toBe(300);
    expect(schedule.creatorShare).toBe(0.5);
  });
});

describe("rankTraders", () => {
  it("ranks on realised profit and marks open positions at the current price", () => {
    const swaps = toSwaps(
      [
        // alice buys 100 for 1, sells 50 for 1 → realised +0.5, holds 50 at cost 0.5
        row({ blockNumber: 1, trader: "0xalice", quoteAmount: E18.toString(), tokenAmount: (100n * E18).toString() }),
        row({ blockNumber: 2, trader: "0xalice", isBuy: false, quoteAmount: E18.toString(), tokenAmount: (50n * E18).toString() }),
        // bob buys and holds
        row({ blockNumber: 3, trader: "0xbob", quoteAmount: (2n * E18).toString(), tokenAmount: (100n * E18).toString() }),
      ],
      18,
    );
    const traders = rankTraders([{ row: { token: "0xt", creator: "0xbob" }, swaps, price: 0.03, rate: 2 }]);
    expect(traders.map((t) => t.wallet)).toEqual(["0xalice", "0xbob"]);
    expect(traders[0]).toMatchObject({ realised: 1, winRate: 1, trades: 2, coins: 1, isCreator: false });
    expect(traders[0].unrealised).toBeCloseTo((50 * 0.03 - 0.5) * 2, 10);
    expect(traders[1]).toMatchObject({ realised: 0, winRate: null, isCreator: true });
    expect(traders[1].holding).toBeCloseTo(100 * 0.03 * 2, 10);
  });
});
