import { describe, it, expect } from "vitest";

import { basisFromSwaps, totalsFor, type Position } from "@/lib/juno/portfolio";

/**
 * Average-cost accounting, which is the part of a portfolio that can lie.
 *
 * A balance is read from chain and is simply true. A *cost* is a policy
 * decision, and the policy chosen here — average cost — is the one that cannot
 * tell a holder the opposite of their real situation. These tests pin the
 * behaviour that choice implies, including the cases where the honest answer is
 * "unknown" rather than a number.
 */

type Swap = { side: "buy" | "sell"; baseAmount: number; quoteAmount: number; seq: number };

const buy = (base: number, quote: number, seq: number): Swap => ({
  side: "buy",
  baseAmount: base,
  quoteAmount: quote,
  seq,
});
const sell = (base: number, quote: number, seq: number): Swap => ({
  side: "sell",
  baseAmount: base,
  quoteAmount: quote,
  seq,
});

describe("basisFromSwaps", () => {
  it("averages the cost of several buys", () => {
    // 100 @ 1.0 then 100 @ 3.0 -> 200 held at an average of 2.0
    const basis = basisFromSwaps([buy(100, 100, 1), buy(100, 300, 2)]);
    expect(basis.quantity).toBe(200);
    expect(basis.cost).toBe(400);
    expect(basis.cost / basis.quantity).toBe(2);
    expect(basis.realised).toBe(0);
    expect(basis.seen).toBe(true);
  });

  it("orders by chain position, not by array position", () => {
    // The RPC returns history newest-first; accounting has to run forwards.
    const forwards = basisFromSwaps([buy(100, 100, 1), sell(50, 100, 2)]);
    const backwards = basisFromSwaps([sell(50, 100, 2), buy(100, 100, 1)]);
    expect(backwards).toEqual(forwards);
  });

  it("realises profit against the average, leaving the average unchanged", () => {
    // 200 held at an average of 2.0; sell 100 for 500 (5.0 each) -> +300 realised.
    const basis = basisFromSwaps([buy(100, 100, 1), buy(100, 300, 2), sell(100, 500, 3)]);
    expect(basis.quantity).toBe(100);
    expect(basis.realised).toBeCloseTo(300, 9);
    // The remaining 100 still carry the same average, not a re-based one.
    expect(basis.cost / basis.quantity).toBeCloseTo(2, 9);
  });

  it("realises a loss as a negative number", () => {
    const basis = basisFromSwaps([buy(100, 400, 1), sell(50, 100, 2)]);
    // Average 4.0; sold 50 for 100 (2.0 each) -> -100.
    expect(basis.realised).toBeCloseTo(-100, 9);
    expect(basis.quantity).toBe(50);
    expect(basis.cost / basis.quantity).toBeCloseTo(4, 9);
  });

  it("does not let an early cheap lot manufacture a gain on a losing position", () => {
    // This is the reason average cost was chosen over FIFO. Bought 100 @ 1 then
    // 100 @ 9 (average 5, position deep underwater at a 2.0 market). Selling
    // 100 at 2.0 is a loss on the position, and FIFO would report +100 profit
    // by matching the sale against the first, cheapest lot.
    const basis = basisFromSwaps([buy(100, 100, 1), buy(100, 900, 2), sell(100, 200, 3)]);
    expect(basis.realised).toBeCloseTo(-300, 9);
    expect(basis.realised).toBeLessThan(0);
  });

  it("closes out to exactly zero rather than a floating-point residue", () => {
    // A residue would divide into an absurd average on the next read.
    const basis = basisFromSwaps([buy(0.1, 0.3, 1), buy(0.2, 0.6, 2), sell(0.3, 1.2, 3)]);
    expect(basis.quantity).toBe(0);
    expect(basis.cost).toBe(0);
    expect(basis.realised).toBeCloseTo(0.3, 9);
  });

  it("only matches the part of a sell that has a tracked cost", () => {
    // 50 bought here, 150 arrived some other way. Selling all 200 can only
    // realise against the 50 whose cost is actually known.
    const basis = basisFromSwaps([buy(50, 100, 1), sell(200, 800, 2)]);
    expect(basis.quantity).toBe(0);
    // 50 matched at an average of 2.0; proceeds for those 50 are 800 * 50/200 = 200.
    expect(basis.realised).toBeCloseTo(100, 9);
  });

  it("reports nothing seen for an empty history", () => {
    const basis = basisFromSwaps([]);
    expect(basis).toEqual({ quantity: 0, cost: 0, realised: 0, seen: false });
  });

  it("reports nothing seen when the wallet only ever sold", () => {
    // Tokens acquired outside the visible window. `seen` false is what makes
    // the caller report a null cost instead of implying the holding is free.
    const basis = basisFromSwaps([sell(100, 200, 1)]);
    expect(basis.seen).toBe(false);
    expect(basis.quantity).toBe(0);
    expect(basis.realised).toBe(0);
  });
});

/**
 * Which headline figures a read has actually earned.
 *
 * This is the third place the same mistake has appeared: summing over an empty
 * list gives zero, zero renders as a number, and a screen that could not read
 * the wallet tells you it is flat. The rule lives in one pure function now so
 * it can be pinned here instead of re-discovered on a phone.
 */
function position(over: Partial<Position> = {}): Position {
  return {
    baseMint: "0xtoken",
    poolAddress: "0xcurve",
    token: "0xtoken",
    curve: "0xcurve",
    chainId: 421614,
    posterUrl: null,
    quoteSymbol: "ETH",
    name: "Coin",
    symbol: "COIN",
    mediaUrl: null,
    mediaMime: null,
    curvePreset: "content",
    balance: 100,
    price: 2,
    value: 200,
    averageCost: 1,
    unrealisedPnl: 100,
    unrealisedPnlPct: 1,
    realisedPnl: 0,
    currency: "USD",
    graduated: false,
    trades: [],
    ...over,
  };
}

describe("totalsFor", () => {
  it("reports a real zero for a wallet that was fully read and holds nothing", () => {
    const { portfolio } = totalsFor([], false);
    expect(portfolio.totalValue).toBe(0);
    expect(portfolio.totalPnl).toBe(0);
  });

  it("reports nothing for a walk that did not finish and found nothing", () => {
    // The distinction the app kept losing: "$0" is a measurement, and nobody
    // took one here.
    const { portfolio } = totalsFor([], true);
    expect(portfolio.totalValue).toBeNull();
    expect(portfolio.totalPnl).toBeNull();
    expect(portfolio.totalPnlPct).toBeNull();
  });

  it("still totals what a partial walk did find", () => {
    // Short of the truth, but every number in it was read. The `partial` flag
    // beside it is what says "at least".
    const { portfolio } = totalsFor([position()], true);
    expect(portfolio.totalValue).toBe(200);
    expect(portfolio.totalPnl).toBe(100);
  });

  it("drops P&L but keeps value when a holding has no recorded cost", () => {
    const { portfolio } = totalsFor(
      [position(), position({ averageCost: null, unrealisedPnl: null, unrealisedPnlPct: null })],
      false,
    );
    expect(portfolio.totalValue).toBe(400);
    expect(portfolio.totalPnl).toBeNull();
  });

  it("labels a mixed-quote portfolio rather than summing units that differ", () => {
    const { portfolio } = totalsFor([position(), position({ currency: "ETH" })], false);
    expect(portfolio.currency).toBe("mixed");
    expect(totalsFor([position(), position()], false).portfolio.currency).toBe("USD");
  });

  it("returns a percentage against cost, not against nothing", () => {
    const { portfolio } = totalsFor([position({ realisedPnl: 0 })], false);
    // 100 profit on 100 balance x 1 average cost.
    expect(portfolio.totalPnlPct).toBeCloseTo(1, 9);
    // Nothing was paid for a position with no recorded cost, so there is no
    // base to divide by and no percentage to report.
    expect(
      totalsFor([position({ averageCost: null, unrealisedPnl: 5 })], false).portfolio.totalPnlPct,
    ).toBeNull();
  });
});
