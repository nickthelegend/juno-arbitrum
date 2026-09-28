import { formatUnits } from "viem";

import type { PricePoint, TradeSide } from "./types";

/**
 * Trades as the maths wants them.
 *
 * A fill no longer has to be decoded from balance changes: the curve
 * emits a `Trade` event with the exact amounts, and the indexer writes it to
 * `juno_trades`. This module turns those rows into decimal numbers and derives
 * the series every surface uses — volume, the 24h change, the chart.
 *
 * `price` is the curve's price *after* the trade (`priceAfter` in the event),
 * not the fill's average price: that is the mark the chart should draw, and it
 * has no fee in it, so the first buy on a fresh curve no longer reads as a
 * fall. Sizes (`quoteAmount`, `baseAmount`) are what was actually paid and
 * received, fee included on a buy and removed on a sell.
 */

export type PoolSwap = {
  txHash: string;
  logIndex: number;
  blockNumber: number;
  /** Total order across the chain: block, then log. */
  seq: number;
  side: TradeSide;
  /** Tokens that changed hands, whole units. */
  baseAmount: number;
  /** Quote that changed hands, whole ETH or USDC. */
  quoteAmount: number;
  /** Curve price after this trade, quote per token. */
  price: number;
  trader: string;
  timestamp: string;
};

/** The raw row shape, as `juno_trades` stores it. */
export type TradeRecord = {
  txHash: string;
  logIndex: number;
  curve: string;
  trader: string;
  isBuy: boolean;
  quoteAmount: string;
  tokenAmount: string;
  feeCreator: string;
  feeProtocol: string;
  priceAfter: string;
  soldAfter: string;
  blockNumber: number;
  blockTime: Date;
};

export function seqOf(blockNumber: number, logIndex: number): number {
  return blockNumber * 1_000_000 + logIndex;
}

export function units(raw: string | bigint, decimals: number): number {
  return Number(formatUnits(typeof raw === "bigint" ? raw : BigInt(raw), decimals));
}

/**
 * Rows → swaps, newest first.
 *
 * `attribute` renames a trader: a launch's first buy is made by the factory
 * on the creator's behalf, and the tokens are the creator's.
 */
export function toSwaps(
  rows: TradeRecord[],
  quoteDecimals: number,
  attribute: Map<string, string> = new Map(),
): PoolSwap[] {
  return rows
    .map((row) => ({
      txHash: row.txHash,
      logIndex: row.logIndex,
      blockNumber: row.blockNumber,
      seq: seqOf(row.blockNumber, row.logIndex),
      side: (row.isBuy ? "buy" : "sell") as TradeSide,
      baseAmount: units(row.tokenAmount, 18),
      quoteAmount: units(row.quoteAmount, quoteDecimals),
      price: units(row.priceAfter, quoteDecimals),
      trader: attribute.get(row.trader) ?? row.trader,
      timestamp: row.blockTime.toISOString(),
    }))
    .sort((a, b) => b.seq - a.seq);
}

/* ------------------------------------------------------------------ */
/* Derived series                                                      */
/* ------------------------------------------------------------------ */

/**
 * Traded quote volume inside a window, in quote units.
 *
 * Null rather than 0 when there is no history at all to measure against.
 */
export function volumeWithin(swaps: PoolSwap[], windowMs: number, now = Date.now()): number | null {
  if (swaps.length === 0) return null;
  let total = 0;
  for (const swap of swaps) {
    const at = Date.parse(swap.timestamp);
    if (Number.isFinite(at) && now - at <= windowMs) total += swap.quoteAmount;
  }
  return total;
}

/** Total traded quote volume across everything recorded. */
export function totalVolume(swaps: PoolSwap[]): number | null {
  if (swaps.length === 0) return null;
  return swaps.reduce((sum, swap) => sum + swap.quoteAmount, 0);
}

export type { PricePoint };

/**
 * Price over time, oldest first — the series a chart draws. A flat stretch
 * means nobody traded rather than a price that held.
 */
export function priceSeries(swaps: PoolSwap[]): PricePoint[] {
  return [...swaps]
    .sort((a, b) => a.seq - b.seq)
    .map((swap) => ({ t: swap.timestamp, price: swap.price, volume: swap.quoteAmount, side: swap.side }));
}

/**
 * Price change across a window, as a signed ratio.
 *
 * Null when there is no trade old enough to compare against — unless the coin
 * is younger than the window, in which case the change since launch *is* the
 * change over the window and the curve's opening price is exactly known.
 */
export function changeWithin(
  swaps: PoolSwap[],
  windowMs: number,
  currentPrice: number,
  now = Date.now(),
  opening?: { price: number; at: number },
): number | null {
  if (currentPrice <= 0) return null;
  if (swaps.length === 0 && !opening) return null;

  const ordered = [...swaps].sort((a, b) => a.seq - b.seq);
  let reference: number | null = null;
  for (const swap of ordered) {
    const at = Date.parse(swap.timestamp);
    if (Number.isFinite(at) && now - at > windowMs) reference = swap.price;
  }
  if (reference === null && opening && now - opening.at <= windowMs) reference = opening.price;
  if (reference === null || reference <= 0) return null;

  return (currentPrice - reference) / reference;
}

export const DAY_MS = 24 * 60 * 60 * 1000;
