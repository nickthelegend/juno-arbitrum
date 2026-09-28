import { identicon } from "./identicon";
import { shortAddress } from "./format";
import type { PoolSwap } from "./swaps";
import type { Activity, Holder } from "./types";

/**
 * Trade rows and holder books, from recorded `Trade` events.
 *
 * Pure: the indexer already wrote the trades down, so nothing here reads the
 * chain. `lib/juno/chain.ts` adds live balances on the coin page.
 */

export function actorFor(wallet: string): Activity["actor"] {
  return { handle: shortAddress(wallet, 6, 4), avatarUrl: identicon(wallet) };
}

/** `quoteUsdRate` converts the quote leg into whatever the row is labelled in (1 when unknown). */
export function activityFromSwap(swap: PoolSwap, quoteUsdRate: number): Activity {
  return {
    id: `${swap.txHash}:${swap.logIndex}`,
    side: swap.side,
    actor: actorFor(swap.trader),
    wallet: swap.trader,
    amount: swap.baseAmount,
    valueUsd: swap.quoteAmount * quoteUsdRate,
    timestamp: swap.timestamp,
    txHash: swap.txHash,
    logIndex: swap.logIndex,
    blockNumber: swap.blockNumber,
  };
}

/** Net tokens per wallet from its buys and sells. Dust at or below 1e-9 is gone. */
export function netPositions(swaps: PoolSwap[]): Map<string, number> {
  const net = new Map<string, number>();
  for (const swap of swaps) {
    const delta = swap.side === "buy" ? swap.baseAmount : -swap.baseAmount;
    net.set(swap.trader, (net.get(swap.trader) ?? 0) + delta);
  }
  return net;
}

/** Rank a balance map into a holder book. */
export function rankHolders(balances: Map<string, number>): Holder[] {
  const held = [...balances.entries()].filter(([, balance]) => balance > 1e-9).sort((a, b) => b[1] - a[1]);
  const total = held.reduce((sum, [, balance]) => sum + balance, 0);
  return held.map(([wallet, balance], index) => ({
    rank: index + 1,
    actor: actorFor(wallet),
    wallet,
    balance,
    share: total > 0 ? balance / total : 0,
  }));
}

/**
 * Net position per wallet, rebuilt from this curve's trades. Buys add, sells
 * subtract, and a wallet that sold everything is not a holder. Tokens moved by
 * plain transfer are invisible here; the coin page corrects that with live
 * balances (`holderBook`).
 */
export function holdersFromSwaps(swaps: PoolSwap[]): Holder[] {
  return rankHolders(netPositions(swaps));
}
