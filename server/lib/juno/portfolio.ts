import "server-only";

import { CallerError } from "./api";
import { isAddr } from "./address";
import type { ChainId } from "./chains";
import { quoteUsdRate } from "./chainlink";
import { presetFromIndex } from "./curves";
import { mediaSrc } from "./media";
import { readCurveStates, tokenBalances } from "./onchain";
import { listCurves, type CurveRow } from "./registry";
import { toSwaps, units, type PoolSwap } from "./swaps";
import { tradesByTrader } from "./trades";

/**
 * What a wallet holds, and what it paid.
 *
 * Balances are read from each token contract (one multicall) — that is the
 * truth about ownership. Cost is not on the balance anywhere, so it comes from
 * the wallet's own recorded trades: every buy added tokens at a known cost,
 * every sell removed them.
 *
 * ## Average cost, and why
 *
 * A sell reduces the position and the cost basis proportionally, leaving the
 * average unchanged. FIFO would let a creator realise a gain by selling their
 * earliest, cheapest tokens while the position is underwater overall — true
 * and misleading. Tokens acquired any other way (a transfer) are held with no
 * recorded cost, reported as a null basis rather than a zero.
 */

export type Position = {
  /** The token (kept under its old name for the app). */
  baseMint: string;
  /** The curve (kept under its old name for the app). */
  poolAddress: string;
  token: string;
  curve: string;
  chainId: number;
  name: string;
  symbol: string;
  mediaUrl: string | null;
  mediaMime: string | null;
  posterUrl: string | null;
  curvePreset: string;
  quoteSymbol: string;
  balance: number;
  price: number;
  value: number;
  averageCost: number | null;
  unrealisedPnl: number | null;
  unrealisedPnlPct: number | null;
  realisedPnl: number;
  currency: string;
  graduated: boolean;
  trades: Array<{ t: string; side: "buy" | "sell"; base: number; price: number; txHash: string }>;
};

export type Portfolio = {
  wallet: string;
  chainId: number;
  positions: Position[];
  totalValue: number | null;
  totalPnl: number | null;
  totalPnlPct: number | null;
  currency: string;
  /** True when a balance read failed and holdings fell back to recorded trades. */
  partial: boolean;
  history: Array<{ t: string; value: number }>;
};

type Basis = {
  /** Tokens acquired and still held, per average-cost accounting. */
  quantity: number;
  /** Total quote paid for `quantity`. */
  cost: number;
  realised: number;
  /** True when at least one buy by this wallet was seen. */
  seen: boolean;
};

/**
 * Walk this wallet's trades oldest-first, maintaining an average-cost basis.
 *
 * A sell is matched against the running average, which is what keeps realised
 * and unrealised P&L consistent with each other.
 */
export function basisFromSwaps(
  swaps: Array<{ side: "buy" | "sell"; baseAmount: number; quoteAmount: number; seq: number }>,
): Basis {
  const ordered = [...swaps].sort((a, b) => a.seq - b.seq);
  const basis: Basis = { quantity: 0, cost: 0, realised: 0, seen: false };

  for (const swap of ordered) {
    if (swap.side === "buy") {
      basis.quantity += swap.baseAmount;
      basis.cost += swap.quoteAmount;
      basis.seen = true;
      continue;
    }

    // Selling more than the tracked position means part of it arrived by
    // transfer. Only the tracked part has a cost to match.
    const matched = Math.min(swap.baseAmount, basis.quantity);
    if (basis.quantity > 0 && matched > 0) {
      const average = basis.cost / basis.quantity;
      const proceeds = swap.quoteAmount * (matched / swap.baseAmount);
      basis.realised += proceeds - average * matched;
      basis.quantity -= matched;
      basis.cost -= average * matched;
    }
  }

  // Floating-point drift on a fully closed position leaves a residue that
  // would otherwise divide into an absurd average.
  if (basis.quantity < 1e-9) {
    basis.quantity = 0;
    basis.cost = 0;
  }

  return basis;
}

/** Every Juno position this wallet has, priced. */
export async function loadPortfolio(chainId: ChainId, walletInput: string): Promise<Portfolio> {
  if (!isAddr(walletInput)) throw new CallerError("wallet is not an address");
  const wallet = walletInput.trim().toLowerCase();

  const rows = await listCurves(chainId, 500);
  const [balances, mine] = await Promise.all([
    tokenBalances(chainId, rows.map((row) => ({ token: row.token, owner: wallet }))).catch(() => null),
    tradesByTrader(chainId, wallet),
  ]);

  const tradesByCurve = new Map<string, typeof mine>();
  for (const trade of mine) tradesByCurve.set(trade.curve, [...(tradesByCurve.get(trade.curve) ?? []), trade]);

  let partial = balances === null;
  const candidates: Array<{ row: CurveRow; balance: number; swaps: PoolSwap[] }> = [];
  rows.forEach((row, i) => {
    const swaps = toSwaps(tradesByCurve.get(row.curve) ?? [], row.quoteDecimals);
    const raw = balances?.[i];
    let balance: number;
    if (raw === null || raw === undefined) {
      if (balances) partial = true;
      balance = Math.max(0, swaps.reduce((sum, s) => sum + (s.side === "buy" ? s.baseAmount : -s.baseAmount), 0));
    } else {
      balance = units(raw, 18);
    }
    if (balance > 1e-12 || swaps.length > 0) candidates.push({ row, balance, swaps });
  });

  const states = await readCurveStates(chainId, candidates.map((c) => c.row.curve));
  const rates = new Map<string, number | null>();
  for (const symbol of new Set(candidates.map((c) => c.row.quoteSymbol))) {
    rates.set(symbol, await quoteUsdRate(symbol).catch(() => null));
  }

  const positions: Position[] = [];
  for (const { row, balance, swaps } of candidates) {
    const state = states.get(row.curve);
    if (!state) {
      partial = true;
      continue;
    }
    const basis = basisFromSwaps(swaps);
    if (balance <= 1e-12 && basis.realised === 0) continue;

    const usd = rates.get(row.quoteSymbol) ?? null;
    const rate = usd ?? 1;
    const currency = usd === null ? row.quoteSymbol : "USD";
    const price = units(state.price, row.quoteDecimals) * rate;
    const value = balance * price;
    const averageCost = basis.seen && basis.quantity > 0 ? (basis.cost / basis.quantity) * rate : null;
    const unrealisedPnl = averageCost === null ? null : value - balance * averageCost;
    const unrealisedPnlPct =
      averageCost === null || averageCost <= 0 || balance <= 0 ? null : (price - averageCost) / averageCost;

    positions.push({
      baseMint: row.token,
      poolAddress: row.curve,
      token: row.token,
      curve: row.curve,
      chainId,
      name: row.name,
      symbol: row.symbol,
      mediaUrl: mediaSrc(row.mediaUrl),
      mediaMime: row.mediaMime,
      posterUrl: mediaSrc(row.posterUrl),
      curvePreset: presetFromIndex(row.preset),
      quoteSymbol: row.quoteSymbol,
      balance,
      price,
      value,
      averageCost,
      unrealisedPnl,
      unrealisedPnlPct,
      realisedPnl: basis.realised * rate,
      currency,
      graduated: Boolean(state.graduated),
      trades: [...swaps]
        .sort((a, b) => a.seq - b.seq)
        .map((swap) => ({
          t: swap.timestamp,
          side: swap.side,
          base: swap.baseAmount,
          // What this wallet actually paid per token, in the display currency.
          price: swap.baseAmount > 0 ? (swap.quoteAmount / swap.baseAmount) * rate : 0,
          txHash: swap.txHash,
        })),
    });
  }

  positions.sort((a, b) => b.value - a.value);
  const totals = totalsFor(positions, partial);
  return {
    wallet,
    chainId,
    positions,
    history: valueOverTime(positions, totals.sum),
    ...totals.portfolio,
    partial,
  };
}

/**
 * The headline figures, and which of them this read actually earned.
 *
 * Pure, and separated from the walk above, because the rule it encodes is the
 * one that keeps getting this wrong and it needs a test that does not need a
 * network. Three distinct "no":
 *
 * - **A complete read that found nothing.** The wallet holds nothing. `$0` and
 *   a zero P&L are real measurements and are reported as such.
 * - **A partial read that found nothing.** A balance read failed, so nobody
 *   knows what this wallet holds. Summing an empty list gives zero, and zero
 *   reads as "flat" — a measurement nobody took. Both totals are null.
 * - **A holding with no recorded cost.** It arrived by transfer, so P&L is
 *   unknowable even though the value is not. Value stands; P&L is null.
 *
 * A partial read that *did* find positions reports its totals as a floor, and
 * `partial` tells the caller so.
 */
export function totalsFor(
  positions: Position[],
  partial: boolean,
): {
  sum: number;
  portfolio: Pick<Portfolio, "totalValue" | "totalPnl" | "totalPnlPct" | "currency">;
} {
  const sum = positions.reduce((total, p) => total + p.value, 0);
  // A total is only meaningful when every part of it is in the same unit.
  const currencies = new Set(positions.map((p) => p.currency));
  const currency = currencies.size === 1 ? [...currencies][0] : "mixed";

  const nothingMeasured = partial && positions.length === 0;
  const anyUnknownCost = positions.some((p) => p.balance > 0 && p.unrealisedPnl === null);

  const totalPnl =
    anyUnknownCost || nothingMeasured
      ? null
      : positions.reduce((total, p) => total + (p.unrealisedPnl ?? 0) + p.realisedPnl, 0);

  const totalCost = positions.reduce(
    (total, p) => total + (p.averageCost === null ? 0 : p.averageCost * p.balance),
    0,
  );

  return {
    sum,
    portfolio: {
      totalValue: nothingMeasured ? null : sum,
      totalPnl,
      totalPnlPct: totalPnl === null || totalCost <= 0 ? null : totalPnl / totalCost,
      currency,
    },
  };
}


/**
 * Rebuild what the wallet was worth at each moment it traded.
 *
 * Walks every position's trades in one merged, time-ordered pass, carrying a
 * running balance and last-seen price per position. At each event the total is
 * the sum of `balance × lastPrice` across everything held — which is the only
 * honest reconstruction available, because no price was observed between
 * trades and inventing one would draw a line through numbers nobody paid.
 *
 * The final point is the live total, so the chart ends where the headline says
 * it does.
 */
export function valueOverTime(
  positions: Position[],
  liveTotal: number,
): Array<{ t: string; value: number }> {
  type Event = { at: number; mint: string; side: "buy" | "sell"; base: number; price: number };

  const events: Event[] = [];
  for (const position of positions) {
    for (const trade of position.trades) {
      const at = Date.parse(trade.t);
      if (Number.isFinite(at)) {
        events.push({ at, mint: position.baseMint, side: trade.side, base: trade.base, price: trade.price });
      }
    }
  }
  if (events.length === 0) return [];

  events.sort((a, b) => a.at - b.at);

  const balance = new Map<string, number>();
  const price = new Map<string, number>();
  const series: Array<{ t: string; value: number }> = [];

  for (const event of events) {
    const held = balance.get(event.mint) ?? 0;
    balance.set(event.mint, event.side === "buy" ? held + event.base : Math.max(0, held - event.base));
    price.set(event.mint, event.price);

    let total = 0;
    for (const [mint, amount] of balance) total += amount * (price.get(mint) ?? 0);
    series.push({ t: new Date(event.at).toISOString(), value: total });
  }

  // End on the live figure rather than on the last trade's mark.
  series.push({ t: new Date().toISOString(), value: liveTotal });
  return series;
}
