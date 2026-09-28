import { describe, expect, it } from "vitest";

import { crowdFromSwaps } from "@/lib/juno/crowd";
import type { PoolSwap } from "@/lib/juno/swaps";

const NOW = Date.parse("2026-09-21T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;

function swap(input: Partial<PoolSwap> & { slot: number }): PoolSwap {
  const { slot, ...over } = input;
  return {
    txHash: `0x${slot.toString(16).padStart(64, "0")}`,
    logIndex: 0,
    blockNumber: slot,
    seq: slot,
    side: "buy",
    baseAmount: 100,
    quoteAmount: 1,
    price: 0.01,
    trader: "alice",
    timestamp: new Date(NOW - HOUR).toISOString(),
    ...over,
  };
}

describe("crowdFromSwaps", () => {
  it("counts distinct traders, not fills", () => {
    const crowd = crowdFromSwaps(
      [
        swap({ slot: 1, trader: "alice" }),
        swap({ slot: 2, trader: "alice" }),
        swap({ slot: 3, trader: "bob" }),
      ],
      false,
      0.01,
      1,
      NOW,
    );
    expect(crowd.traders).toBe(2);
  });

  it("counts a wallet that sold everything back as no longer holding", () => {
    const crowd = crowdFromSwaps(
      [
        swap({ slot: 1, trader: "alice", side: "buy", baseAmount: 100 }),
        swap({ slot: 2, trader: "alice", side: "sell", baseAmount: 100 }),
        swap({ slot: 3, trader: "bob", side: "buy", baseAmount: 50 }),
      ],
      false,
      0.01,
      1,
      NOW,
    );
    expect(crowd.holdersStill).toBe(1);
  });

  it("takes the earliest buy by chain position, not by list order", () => {
    const crowd = crowdFromSwaps(
      [
        swap({ slot: 9, trader: "late", price: 0.05 }),
        swap({ slot: 2, trader: "early", price: 0.01 }),
      ],
      false,
      0.02,
      1,
      NOW,
    );
    expect(crowd.firstBuyer?.wallet).toBe("early");
    expect(crowd.firstBuyer?.price).toBe(0.01);
  });

  it("measures the first buyer's return in the unit a fill is priced in", () => {
    // The bug this covers: comparing a quote-denominated fill price against a
    // USD price reported a 113x return on an entry that was flat, because the
    // quote token happened to cost $114.
    const crowd = crowdFromSwaps([swap({ slot: 1, price: 0.01 })], false, 0.02, 114, NOW);
    expect(crowd.firstBuyer?.multiple).toBeCloseTo(2, 10);
    expect(crowd.quoteUsdRate).toBe(114);
  });

  it("refuses a multiple it cannot define", () => {
    const crowd = crowdFromSwaps([swap({ slot: 1, price: 0 })], false, 0.02, 1, NOW);
    expect(crowd.firstBuyer?.multiple).toBeNull();
  });

  it("nets buys against sells inside each window", () => {
    const crowd = crowdFromSwaps(
      [
        swap({ slot: 1, side: "buy", quoteAmount: 5, timestamp: new Date(NOW - HOUR).toISOString() }),
        swap({ slot: 2, side: "sell", quoteAmount: 2, timestamp: new Date(NOW - 2 * HOUR).toISOString() }),
        // Outside 24h, inside the week.
        swap({ slot: 3, side: "buy", quoteAmount: 9, timestamp: new Date(NOW - 48 * HOUR).toISOString() }),
      ],
      false,
      0.01,
      1,
      NOW,
    );
    expect(crowd.netFlow24h).toBeCloseTo(3, 10);
    expect(crowd.netFlow7d).toBeCloseTo(12, 10);
    expect(crowd.fills24h).toBe(2);
  });

  it("has no first buyer when the window holds only sells", () => {
    const crowd = crowdFromSwaps([swap({ slot: 1, side: "sell" })], false, 0.01, 1, NOW);
    expect(crowd.firstBuyer).toBeNull();
    expect(crowd.biggestBuy).toBeNull();
  });
});
