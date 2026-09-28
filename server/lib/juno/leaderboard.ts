import "server-only";

import type { ChainId } from "./chains";
import { quoteUsdRate } from "./chainlink";
import { readCurveStates } from "./onchain";
import { basisFromSwaps } from "./portfolio";
import { listCurves, type CurveRow } from "./registry";
import { ttlCache } from "./rpc";
import { toSwaps, units, type PoolSwap } from "./swaps";
import { tradesForCurves } from "./trades";

/**
 * Who is actually good at this, from every recorded trade.
 *
 * Ranked on **realised** profit only: quote received on a sell minus the
 * average cost of the tokens sold. Paper gains are reported beside the rank
 * but never decide it — a board that counts them ranks whoever bought
 * earliest, not whoever traded well.
 */

export type TraderRow = {
  wallet: string;
  realised: number;
  unrealised: number | null;
  trades: number;
  coins: number;
  winRate: number | null;
  bestExit: number | null;
  holding: number;
  isCreator: boolean;
};

export type Leaderboard = {
  traders: TraderRow[];
  partial: boolean;
  poolsRead: number;
  poolsTotal: number;
};

type CurveInput = { row: Pick<CurveRow, "token" | "creator">; swaps: PoolSwap[]; price: number | null; rate: number };

/** Pure: rank traders across curves. `price` is each curve's current price in quote units. */
export function rankTraders(curves: CurveInput[]): TraderRow[] {
  type Acc = {
    realised: number;
    unrealised: number;
    unrealisedKnown: boolean;
    trades: number;
    coins: Set<string>;
    wins: number;
    decided: number;
    bestExit: number | null;
    holding: number;
  };
  const byWallet = new Map<string, Acc>();
  const creators = new Set(curves.map((curve) => curve.row.creator));
  const acc = (wallet: string): Acc => {
    let found = byWallet.get(wallet);
    if (!found) {
      found = { realised: 0, unrealised: 0, unrealisedKnown: true, trades: 0, coins: new Set(), wins: 0, decided: 0, bestExit: null, holding: 0 };
      byWallet.set(wallet, found);
    }
    return found;
  };

  for (const { row, swaps, price, rate } of curves) {
    const perTrader = new Map<string, PoolSwap[]>();
    for (const swap of swaps) perTrader.set(swap.trader, [...(perTrader.get(swap.trader) ?? []), swap]);

    for (const [wallet, list] of perTrader) {
      const entry = acc(wallet);
      entry.trades += list.length;
      entry.coins.add(row.token);

      const basis = basisFromSwaps(list);
      entry.realised += basis.realised * rate;
      if (basis.quantity > 0) {
        if (price === null) entry.unrealisedKnown = false;
        else {
          const value = basis.quantity * price * rate;
          entry.holding += value;
          if (basis.seen) entry.unrealised += value - basis.cost * rate;
          else entry.unrealisedKnown = false;
        }
      }

      // Win rate and best exit: the same average-cost rule, walked sell by sell.
      let quantity = 0;
      let cost = 0;
      for (const swap of [...list].sort((a, b) => a.seq - b.seq)) {
        if (swap.side === "buy") {
          quantity += swap.baseAmount;
          cost += swap.quoteAmount;
          continue;
        }
        if (quantity <= 0) continue;
        const matched = Math.min(swap.baseAmount, quantity);
        const average = cost / quantity;
        const proceeds = swap.quoteAmount * (matched / swap.baseAmount);
        const delta = (proceeds - average * matched) * rate;
        quantity -= matched;
        cost -= average * matched;
        entry.decided += 1;
        if (delta > 0) entry.wins += 1;
        if (entry.bestExit === null || delta > entry.bestExit) entry.bestExit = delta;
      }
    }
  }

  return [...byWallet.entries()]
    .map(([wallet, entry]): TraderRow => ({
      wallet,
      realised: entry.realised,
      unrealised: entry.unrealisedKnown ? entry.unrealised : null,
      trades: entry.trades,
      coins: entry.coins.size,
      winRate: entry.decided > 0 ? entry.wins / entry.decided : null,
      bestExit: entry.bestExit,
      holding: entry.holding,
      isCreator: creators.has(wallet),
    }))
    .sort((a, b) => b.realised - a.realised || b.coins - a.coins || b.trades - a.trades);
}

const board = ttlCache<Leaderboard>(30_000);

export async function leaderboard(chainId: ChainId): Promise<Leaderboard> {
  return board.get(`${chainId}`, async () => {
    const rows = await listCurves(chainId, 500);
    const [trades, states] = await Promise.all([
      tradesForCurves(rows.map((row) => row.curve), 50_000),
      readCurveStates(chainId, rows.map((row) => row.curve)),
    ]);
    const rates = new Map<string, number>();
    for (const symbol of new Set(rows.map((row) => row.quoteSymbol))) {
      rates.set(symbol, (await quoteUsdRate(symbol).catch(() => null)) ?? 1);
    }
    let partial = false;
    const inputs = rows.map((row) => {
      const state = states.get(row.curve);
      if (!state) partial = true;
      return {
        row,
        swaps: toSwaps(trades.get(row.curve) ?? [], row.quoteDecimals),
        price: state ? units(state.price, row.quoteDecimals) : null,
        rate: rates.get(row.quoteSymbol) ?? 1,
      };
    });
    return {
      traders: rankTraders(inputs),
      partial,
      poolsRead: inputs.filter((input) => input.price !== null).length,
      poolsTotal: rows.length,
    };
  });
}
