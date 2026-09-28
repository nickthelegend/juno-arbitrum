import "server-only";

import { erc20Abi, parseAbi } from "viem";

import { curveMathAbi, junoCurveAbi, junoFactoryAbi } from "@config/abi";
import { deployment, publicClient, type ChainId } from "./chains";
import { ttlCache, withRetry } from "./rpc";

/**
 * Contract reads, cached.
 *
 * Every `readContract` made in the same tick is folded by viem into one
 * Multicall3 call (see `publicClient`), so hydrating forty curves costs one
 * round trip for their states rather than forty.
 */

type Hex = `0x${string}`;

/** `IJunoCurve.State`, as viem decodes it. */
export type CurveStateRaw = {
  token: Hex;
  quote: Hex;
  creator: Hex;
  preset: number;
  p0: bigint;
  capFp: bigint;
  supply: bigint;
  curveSupply: bigint;
  sold: bigint;
  quoteReserve: bigint;
  creatorFees: bigint;
  protocolFees: bigint;
  feeBps: bigint;
  price: bigint;
  graduationPrice: bigint;
  graduated: boolean;
  pool: Hex;
  positionId: bigint;
  feed: Hex;
  bandBps: number;
  maxAge: number;
  launchedAt: bigint;
};

export type BuyQuoteRaw = {
  tokensOut: bigint;
  quoteIn: bigint;
  fee: bigint;
  priceAfter: bigint;
  bandOk: boolean;
  marketOpen: boolean;
  refPrice: bigint;
};

export type SellQuoteRaw = { quoteOut: bigint; fee: bigint; priceAfter: bigint };

export type FactoryPreset = {
  feeStartBps: number;
  feeEndBps: number;
  feeDecaySeconds: number;
  curveSupplyPct: number;
  poolFee: number;
  minCapFp: bigint;
  maxCapFp: bigint;
  trackerOnly: boolean;
};

const stateCache = ttlCache<CurveStateRaw>(4_000);

/** A curve's full state. Short-lived cache: a trade moves it. */
export async function readCurveState(chainId: ChainId, curve: string): Promise<CurveStateRaw> {
  const address = curve.toLowerCase() as Hex;
  return stateCache.get(`${chainId}:${address}`, async () => {
    const state = await withRetry(() =>
      publicClient(chainId).readContract({ address, abi: junoCurveAbi, functionName: "state" }),
    );
    return state as unknown as CurveStateRaw;
  });
}

/** Many states at once; a curve that would not answer is null. */
export async function readCurveStates(
  chainId: ChainId,
  curves: string[],
): Promise<Map<string, CurveStateRaw | null>> {
  const results = await Promise.all(curves.map((curve) => readCurveState(chainId, curve).catch(() => null)));
  return new Map(curves.map((curve, i) => [curve.toLowerCase(), results[i]]));
}

export function invalidateCurve(chainId: ChainId, curve: string): void {
  stateCache.invalidate(`${chainId}:${curve.toLowerCase()}`);
}

const presetCache = new Map<string, FactoryPreset>();

/** The factory's economic parameters for a preset. Immutable once deployed; cached forever. */
export async function readFactoryPreset(chainId: ChainId, index: number): Promise<FactoryPreset> {
  const factory = deployment(chainId)?.factory;
  if (!factory) throw new Error(`No factory on chain ${chainId}`);
  const key = `${chainId}:${factory}:${index}`;
  const hit = presetCache.get(key);
  if (hit) return hit;
  const raw = (await withRetry(() =>
    publicClient(chainId).readContract({ address: factory, abi: junoFactoryAbi, functionName: "preset", args: [index] }),
  )) as unknown as FactoryPreset;
  const preset: FactoryPreset = {
    feeStartBps: Number(raw.feeStartBps),
    feeEndBps: Number(raw.feeEndBps),
    feeDecaySeconds: Number(raw.feeDecaySeconds),
    curveSupplyPct: Number(raw.curveSupplyPct),
    poolFee: Number(raw.poolFee),
    minCapFp: BigInt(raw.minCapFp),
    maxCapFp: BigInt(raw.maxCapFp),
    trackerOnly: Boolean(raw.trackerOnly),
  };
  presetCache.set(key, preset);
  return preset;
}

const mathAbiFallback = parseAbi(["function math() view returns (address)"]);
const boundaryCache = new Map<string, { prices: bigint[]; sizes: bigint[] }>();

/**
 * The sixteen segment boundaries of one curve: prices P[0..16] (quote base
 * units per whole token) and the tokens each segment sells. Fixed at launch,
 * so cached forever.
 */
export async function readBoundaries(
  chainId: ChainId,
  input: { curve: string; preset: number; p0: bigint; capFp: bigint; curveSupply: bigint },
): Promise<{ prices: bigint[]; sizes: bigint[] }> {
  const key = `${chainId}:${input.curve.toLowerCase()}`;
  const hit = boundaryCache.get(key);
  if (hit) return hit;
  const client = publicClient(chainId);
  const math =
    deployment(chainId)?.curveMath ??
    ((await client.readContract({
      address: input.curve as Hex,
      abi: mathAbiFallback,
      functionName: "math",
    })) as Hex);
  const [prices, sizes] = (await withRetry(() =>
    client.readContract({
      address: math,
      abi: curveMathAbi,
      functionName: "boundaries",
      args: [input.preset, input.p0, input.capFp, input.curveSupply],
    }),
  )) as unknown as [readonly bigint[], readonly bigint[]];
  const value = { prices: [...prices], sizes: [...sizes] };
  boundaryCache.set(key, value);
  return value;
}

/**
 * Quote a curve would hold once full: the area under its sixteen linear
 * segments. Integer maths, rounded down; the contract rounds each segment up,
 * so this can be short by a few wei — fine for a progress bar.
 */
export function fullReserve(boundaries: { prices: bigint[]; sizes: bigint[] }): bigint {
  let total = 0n;
  for (let i = 0; i < boundaries.sizes.length; i += 1) {
    const avg = (boundaries.prices[i] + boundaries.prices[i + 1]) / 2n;
    total += (avg * boundaries.sizes[i]) / 10n ** 18n;
  }
  return total;
}

export async function quoteBuy(chainId: ChainId, curve: string, quoteIn: bigint): Promise<BuyQuoteRaw> {
  return (await publicClient(chainId).readContract({
    address: curve as Hex,
    abi: junoCurveAbi,
    functionName: "quoteBuy",
    args: [quoteIn],
  })) as unknown as BuyQuoteRaw;
}

export async function quoteBuyExactOut(chainId: ChainId, curve: string, tokensOut: bigint): Promise<BuyQuoteRaw> {
  return (await publicClient(chainId).readContract({
    address: curve as Hex,
    abi: junoCurveAbi,
    functionName: "quoteBuyExactOut",
    args: [tokensOut],
  })) as unknown as BuyQuoteRaw;
}

export async function quoteSell(chainId: ChainId, curve: string, tokensIn: bigint): Promise<SellQuoteRaw> {
  return (await publicClient(chainId).readContract({
    address: curve as Hex,
    abi: junoCurveAbi,
    functionName: "quoteSell",
    args: [tokensIn],
  })) as unknown as SellQuoteRaw;
}

/** ERC-20 balances of many (token, owner) pairs in one multicall. Null where a read failed. */
export async function tokenBalances(
  chainId: ChainId,
  pairs: Array<{ token: string; owner: string }>,
): Promise<Array<bigint | null>> {
  if (pairs.length === 0) return [];
  const results = await publicClient(chainId).multicall({
    allowFailure: true,
    contracts: pairs.map((pair) => ({
      address: pair.token as Hex,
      abi: erc20Abi,
      functionName: "balanceOf" as const,
      args: [pair.owner as Hex] as const,
    })),
  });
  return results.map((result) => (result.status === "success" ? (result.result as bigint) : null));
}

export async function ethBalance(chainId: ChainId, owner: string): Promise<bigint> {
  return withRetry(() => publicClient(chainId).getBalance({ address: owner as Hex }));
}

export async function allowance(chainId: ChainId, token: string, owner: string, spender: string): Promise<bigint> {
  return withRetry(() =>
    publicClient(chainId).readContract({
      address: token as Hex,
      abi: erc20Abi,
      functionName: "allowance",
      args: [owner as Hex, spender as Hex],
    }),
  );
}
