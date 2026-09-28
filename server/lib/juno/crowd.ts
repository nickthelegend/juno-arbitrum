import { DAY_MS } from "./swaps";
import type { PoolSwap } from "./swaps";

/**
 * A price is a number. A crowd is a reason.
 *
 * The coin page could tell you what a coin costs, how the curve was shaped and
 * what it tracks — and nothing at all about whether anyone else was there. On
 * a bonding curve that is the more useful half: the curve's shape is fixed and
 * public, so the only thing that differs between two coins on the same preset
 * is who has been buying.
 *
 * Every figure here comes out of the same recorded trades the chart and the
 * portfolio already use. Nothing new is read from the chain.
 */

export type Crowd = {
  /**
   * What one quote token is worth in USD, or 1 when no feed answered.
   *
   * Every flow figure below is in **quote units** — that is the unit a fill is
   * denominated in, and converting them here would lose the distinction
   * between "no feed" and "one dollar". The client multiplies.
   */
  quoteUsdRate: number;
  /** Distinct wallets that have traded this curve. */
  traders: number;
  /** Wallets that have bought and not sold anything back. */
  holdersStill: number;
  /**
   * The earliest fill in the window, and the price it got.
   *
   * Null when nobody has bought yet. `price` is the curve price their buy
   * left behind, in quote units.
   */
  firstBuyer: { wallet: string; price: number; timestamp: string; multiple: number | null } | null;
  /** Quote in minus quote out over the last 24h, in quote units. Positive is accumulation. */
  netFlow24h: number;
  /** Quote in minus quote out over the last 7 days, in quote units. */
  netFlow7d: number;
  /** Fills in the last 24h, so a flow of zero can be told from no trading. */
  fills24h: number;
  /** The single largest buy in the window, in quote units. */
  biggestBuy: number | null;
  /** True when the trade record is known to be incomplete (indexer behind). */
  partial: boolean;
};

const WEEK_MS = 7 * DAY_MS;

export function crowdFromSwaps(
  swaps: PoolSwap[],
  partial: boolean,
  /** The curve's current price in **quote** units — the same unit a fill's price is in. */
  priceNow: number,
  /** USD per quote token, or 1 when no feed answered. */
  quoteUsdRate = 1,
  now = Date.now(),
): Crowd {
  const traders = new Set<string>();
  // Net base position per wallet, so "still holding" is a fact about their
  // fills rather than a balance read — the balance would also count tokens
  // received by transfer, which is not the same claim.
  const net = new Map<string, number>();

  let netFlow24h = 0;
  let netFlow7d = 0;
  let fills24h = 0;
  let biggestBuy: number | null = null;
  let first: PoolSwap | null = null;

  for (const swap of swaps) {
    traders.add(swap.trader);
    net.set(swap.trader, (net.get(swap.trader) ?? 0) + (swap.side === "buy" ? swap.baseAmount : -swap.baseAmount));

    const age = now - Date.parse(swap.timestamp);
    const signed = swap.side === "buy" ? swap.quoteAmount : -swap.quoteAmount;
    if (Number.isFinite(age)) {
      if (age <= DAY_MS) {
        netFlow24h += signed;
        fills24h += 1;
      }
      if (age <= WEEK_MS) netFlow7d += signed;
    }

    if (swap.side === "buy") {
      if (biggestBuy === null || swap.quoteAmount > biggestBuy) biggestBuy = swap.quoteAmount;
      if (first === null || swap.seq < first.seq) first = swap;
    }
  }

  let holdersStill = 0;
  // A hair above zero, not zero: selling a position back out leaves
  // floating-point dust that would otherwise count as still holding.
  for (const quantity of net.values()) if (quantity > 1e-9) holdersStill += 1;

  return {
    quoteUsdRate,
    traders: traders.size,
    holdersStill,
    firstBuyer:
      first === null
        ? null
        : {
            wallet: first.trader,
            price: first.price,
            timestamp: first.timestamp,
            // What that entry is worth now, as a multiple. Null rather than a
            // number when either price is zero — a multiple of a zero price is
            // not a large gain, it is an undefined one.
            multiple: first.price > 0 && priceNow > 0 ? priceNow / first.price : null,
          },
    netFlow24h,
    netFlow7d,
    fills24h,
    biggestBuy,
    partial,
  };
}
