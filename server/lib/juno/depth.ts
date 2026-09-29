import "server-only";

import { formatUnits, parseUnits } from "viem";

import { junoCurveAbi } from "@config/abi";
import { publicClient, type ChainId } from "./chains";
import { fullReserve, type BuyQuoteRaw, type CurveStateRaw, type SellQuoteRaw } from "./onchain";
import type { CurveRow } from "./registry";

/**
 * How much this curve can take.
 *
 * Every size is quoted by the curve's own `quoteBuy` / `quoteSell` views, all
 * sizes in one multicall — the same numbers a trade at that size would get,
 * this block. Nothing is modelled.
 */

export type DepthPoint = {
  /** Input size: quote units for a buy, tokens for a sell. */
  amountIn: number;
  amountOut: number;
  /** Realised price of the whole fill, quote per token. */
  averagePrice: number;
  /** Shortfall against spot, fee included: 0.012 is 1.2%. */
  priceImpact: number;
  /** The part the curve caused, fee excluded. */
  curveImpact: number;
  fee: number;
  /**
   * The contract would accept this trade now: for a tracker buy, the curve's
   * own `bandOk && marketOpen` verdict; always true for posts and sells.
   */
  allowed: boolean;
};

export type SizeSuggestion = DepthPoint & { ceilingReached: boolean };

type Hex = `0x${string}`;

/** Log-spaced sizes from `max / 1000` to `max`. */
export function logSizes(max: number, steps: number): number[] {
  if (!(max > 0) || steps < 2) return max > 0 ? [max] : [];
  const min = max / 1000;
  return Array.from({ length: steps }, (_, i) => min * Math.pow(max / min, i / (steps - 1)));
}

async function quoteSizes(
  chainId: ChainId,
  row: CurveRow,
  side: "buy" | "sell",
  sizes: number[],
  spot: number,
): Promise<Array<DepthPoint | null>> {
  const decimals = side === "buy" ? row.quoteDecimals : 18;
  const raw = sizes.map((size) => parseUnits(size.toFixed(decimals), decimals));
  const results = await publicClient(chainId).multicall({
    allowFailure: true,
    contracts: raw.map((amount) => ({
      address: row.curve as Hex,
      abi: junoCurveAbi,
      functionName: side === "buy" ? ("quoteBuy" as const) : ("quoteSell" as const),
      args: [amount] as const,
    })),
  });
  return results.map((result, i) => {
    if (result.status !== "success") return null;
    if (side === "buy") {
      const q = result.result as unknown as BuyQuoteRaw;
      if (q.tokensOut === 0n) return null;
      const quoteIn = Number(formatUnits(q.quoteIn, row.quoteDecimals));
      const fee = Number(formatUnits(q.fee, row.quoteDecimals));
      const out = Number(formatUnits(q.tokensOut, 18));
      const average = quoteIn / out;
      return {
        amountIn: quoteIn,
        amountOut: out,
        averagePrice: average,
        priceImpact: spot > 0 ? average / spot - 1 : 0,
        curveImpact: spot > 0 ? (quoteIn - fee) / out / spot - 1 : 0,
        fee,
        allowed: q.bandOk && q.marketOpen,
      };
    }
    const q = result.result as unknown as SellQuoteRaw;
    if (q.quoteOut === 0n) return null;
    const tokensIn = Number(formatUnits(raw[i], 18));
    const out = Number(formatUnits(q.quoteOut, row.quoteDecimals));
    const fee = Number(formatUnits(q.fee, row.quoteDecimals));
    const average = out / tokensIn;
    return {
      amountIn: tokensIn,
      amountOut: out,
      averagePrice: average,
      priceImpact: spot > 0 ? 1 - average / spot : 0,
      curveImpact: spot > 0 ? 1 - (out + fee) / tokensIn / spot : 0,
      fee,
      allowed: true,
    };
  });
}

/**
 * The largest size worth sampling: what is left to buy before graduation
 * (with the fee on top), or what has been sold, for a sell.
 */
export function depthCeiling(
  row: CurveRow,
  state: CurveStateRaw,
  side: "buy" | "sell",
  boundaries: { prices: bigint[]; sizes: bigint[] } | null,
): number {
  if (side === "sell") return Number(formatUnits(state.sold, 18));
  const remaining = boundaries ? fullReserve(boundaries) - state.quoteReserve : 0n;
  const withFee = (remaining * (10_000n + state.feeBps)) / 10_000n;
  return Math.max(Number(formatUnits(withFee > 0n ? withFee : 0n, row.quoteDecimals)), 0);
}

export async function sampleDepth(
  chainId: ChainId,
  row: CurveRow,
  state: CurveStateRaw,
  side: "buy" | "sell",
  max: number,
  steps = 12,
): Promise<DepthPoint[]> {
  const spot = Number(formatUnits(state.price, row.quoteDecimals));
  const points = await quoteSizes(chainId, row, side, logSizes(max, steps), spot);
  return points.filter((point): point is DepthPoint => point !== null);
}

/**
 * The largest trade whose curve movement stays under `budget` (0.01 = 1%).
 * Two multicalls: a coarse log sweep, then a fine sweep between the last size
 * inside the budget and the first outside it.
 */
export async function suggestSize(
  chainId: ChainId,
  row: CurveRow,
  state: CurveStateRaw,
  side: "buy" | "sell",
  budget: number,
  ceiling: number,
): Promise<SizeSuggestion | null> {
  if (!(budget > 0) || !(ceiling > 0)) return null;
  const spot = Number(formatUnits(state.price, row.quoteDecimals));
  const coarseSizes = logSizes(ceiling, 24);
  const coarse = await quoteSizes(chainId, row, side, coarseSizes, spot);

  let best: DepthPoint | null = null;
  let lastIn = -1;
  for (let i = 0; i < coarse.length; i += 1) {
    const point = coarse[i];
    if (point && point.curveImpact <= budget) {
      best = point;
      lastIn = i;
    } else if (best) break;
  }
  if (!best) return null;
  if (lastIn === coarse.length - 1) return { ...best, ceilingReached: true };

  const low = coarseSizes[lastIn];
  const high = coarseSizes[lastIn + 1];
  const fineSizes = Array.from({ length: 16 }, (_, i) => low + ((high - low) * (i + 1)) / 17);
  const fine = await quoteSizes(chainId, row, side, fineSizes, spot);
  for (const point of fine) {
    if (point && point.curveImpact <= budget) best = point;
    else break;
  }
  return { ...best, ceilingReached: false };
}
