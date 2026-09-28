import "server-only";

import { parseAbi } from "viem";

import { TRACKER_MAX_AGE_SECONDS } from "@config/addresses";
import { ONE, publicClient, stockFeeds, type ChainId } from "./chains";
import { tryRead, ttlCache } from "./rpc";

/**
 * Chainlink reads: the stock feeds trackers are held to, and ETH/USD for
 * turning ETH-quoted figures into dollars.
 *
 * On Arbitrum Sepolia the stock feeds are Juno's `MockAggregator`s, kept in
 * step with the real Arbitrum One feeds by `scripts/keep-feeds-fresh.ts`; they
 * answer the same `AggregatorV3Interface` calls.
 */

export const aggregatorAbi = parseAbi([
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
  "function decimals() view returns (uint8)",
]);

/** Chainlink ETH / USD on Arbitrum One, used for both chains. */
export const ETH_USD_FEED = "0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612" as const;

export const STOCK_NAMES: Record<string, string> = {
  TSLA: "Tesla",
  NVDA: "NVIDIA",
  AAPL: "Apple",
};

export type FeedReading = {
  feed: string;
  price: number;
  /** Raw answer and decimals, for exact comparisons. */
  answer: bigint;
  decimals: number;
  /** Unix seconds. */
  updatedAt: number;
  ageSeconds: number;
};

const decimalsCache = new Map<string, number>();
const readings = ttlCache<FeedReading | null>(30_000);

async function feedDecimals(chainId: ChainId, feed: `0x${string}`): Promise<number> {
  const key = `${chainId}:${feed.toLowerCase()}`;
  const hit = decimalsCache.get(key);
  if (hit !== undefined) return hit;
  const value = await publicClient(chainId).readContract({ address: feed, abi: aggregatorAbi, functionName: "decimals" });
  decimalsCache.set(key, Number(value));
  return Number(value);
}

/** The latest answer of one feed, or null when it could not be read. */
export async function readFeed(chainId: ChainId, feed: string, now = Date.now()): Promise<FeedReading | null> {
  const address = feed.toLowerCase() as `0x${string}`;
  return readings.get(
    `${chainId}:${address}`,
    async () =>
      tryRead(async () => {
        const [decimals, round] = await Promise.all([
          feedDecimals(chainId, address),
          publicClient(chainId).readContract({ address, abi: aggregatorAbi, functionName: "latestRoundData" }),
        ]);
        const answer = round[1];
        const updatedAt = Number(round[3]);
        if (answer <= 0n) return null;
        return {
          feed: address,
          answer,
          decimals,
          price: Number(answer) / 10 ** decimals,
          updatedAt,
          ageSeconds: Math.max(0, Math.floor(now / 1000) - updatedAt),
        };
      }),
    (value) => (value ? 30_000 : 5_000),
  );
}

/** Open means fresh: the contract refuses buys once the answer is older than `maxAge`. */
export function marketOpen(reading: Pick<FeedReading, "updatedAt">, maxAgeSeconds = TRACKER_MAX_AGE_SECONDS, now = Date.now()): boolean {
  return Math.floor(now / 1000) - reading.updatedAt <= maxAgeSeconds;
}

const ethUsdCache = ttlCache<number | null>(60_000);

/** USD per ETH from Chainlink on Arbitrum One, or null when it would not answer. */
export async function ethUsd(): Promise<number | null> {
  return ethUsdCache.get(
    "eth-usd",
    async () => {
      const reading = await readFeed(ONE, ETH_USD_FEED).catch(() => null);
      return reading?.price ?? null;
    },
    (value) => (value === null ? 5_000 : 60_000),
  );
}

/** USD per quote token: ETH/USD for ETH, 1 for USDC. Null when unknown. */
export async function quoteUsdRate(symbol: string): Promise<number | null> {
  if (symbol === "USDC") return 1;
  return ethUsd();
}

export type StockReference = {
  symbol: string;
  name: string;
  feed: string;
  price: number | null;
  updatedAt: string | null;
  ageSeconds: number | null;
  marketOpen: boolean;
};

/** Every stock feed on this chain, read. */
export async function stockReferences(chainId: ChainId): Promise<StockReference[]> {
  const feeds = stockFeeds(chainId);
  const reads = await Promise.all(feeds.map((entry) => readFeed(chainId, entry.feed).catch(() => null)));
  return feeds.map((entry, i) => {
    const reading = reads[i];
    return {
      symbol: entry.symbol,
      name: STOCK_NAMES[entry.symbol] ?? entry.symbol,
      feed: entry.feed,
      price: reading?.price ?? null,
      updatedAt: reading ? new Date(reading.updatedAt * 1000).toISOString() : null,
      ageSeconds: reading?.ageSeconds ?? null,
      marketOpen: reading ? marketOpen(reading) : false,
    };
  });
}
