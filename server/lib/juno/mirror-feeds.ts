import "server-only";

import { after } from "next/server";
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { mockAggregatorAbi } from "@config/abi";
import { aggregatorAbi } from "./chainlink";
import { ONE, publicClient, rpcUrls, SEPOLIA, stockFeeds, viemChain, type ChainId } from "./chains";

/**
 * Keep the Sepolia stock feeds in step with Chainlink's Arbitrum One feeds,
 * on read.
 *
 * Chainlink has no equity feeds on Arbitrum Sepolia, so Sepolia trackers read
 * Juno's MockAggregators, which must carry the real answer and timestamp.
 * `scripts/keep-feeds-fresh.ts` does that from a GitHub Actions cron, but
 * GitHub's scheduler can go hours without firing; left alone, the mirrors go
 * stale and a tracker reads "market closed" in the middle of a trading day.
 * So, like the indexer (catch-up.ts), whoever reads prices also refreshes
 * them: after the response, at most every 5 minutes per instance, a mirror is
 * rewritten when the real price moved 0.5% or its timestamp is 4 hours ahead.
 * Signed by KEEPER_PRIVATE_KEY, the key that owns only the three mocks.
 */
const THROTTLE_MS = 5 * 60_000;
const DEVIATION_BPS = 50n;
const MAX_LAG_SECONDS = 4n * 3600n;
let last = 0;
let running = false;

export function mirrorFeedsAfter(chainId: ChainId): void {
  const key = process.env.KEEPER_PRIVATE_KEY;
  if (chainId !== SEPOLIA || !key || running || Date.now() - last < THROTTLE_MS) return;
  last = Date.now();
  after(async () => {
    running = true;
    try {
      await mirrorFeeds(key.startsWith("0x") ? (key as `0x${string}`) : `0x${key}`);
    } catch (error) {
      console.warn("[juno mirror-feeds]", error instanceof Error ? error.message : error);
    } finally {
      running = false;
    }
  });
}

export async function mirrorFeeds(key: `0x${string}`): Promise<Array<{ symbol: string; hash: string }>> {
  const sepolia = publicClient(SEPOLIA);
  const one = publicClient(ONE);
  const wallet = createWalletClient({ account: privateKeyToAccount(key), chain: viemChain(SEPOLIA), transport: http(rpcUrls(SEPOLIA)[0]) });
  const real = new Map(stockFeeds(ONE).map((entry) => [entry.symbol, entry.feed]));
  const written: Array<{ symbol: string; hash: string }> = [];
  for (const { symbol, feed: mock } of stockFeeds(SEPOLIA)) {
    const source = real.get(symbol);
    if (!source) continue;
    const [[, answer, , updatedAt], [, mockAnswer, , mockUpdated]] = await Promise.all([
      one.readContract({ address: source, abi: aggregatorAbi, functionName: "latestRoundData" }),
      sepolia.readContract({ address: mock, abi: aggregatorAbi, functionName: "latestRoundData" }),
    ]);
    if (answer === mockAnswer && updatedAt === mockUpdated) continue;
    const moved = mockAnswer === 0n ? DEVIATION_BPS : ((answer > mockAnswer ? answer - mockAnswer : mockAnswer - answer) * 10_000n) / mockAnswer;
    if (moved < DEVIATION_BPS && updatedAt - mockUpdated < MAX_LAG_SECONDS) continue;
    const hash = await wallet.writeContract({ address: mock, abi: mockAggregatorAbi, functionName: "setAnswer", args: [answer, updatedAt] });
    await sepolia.waitForTransactionReceipt({ hash });
    written.push({ symbol, hash });
  }
  return written;
}
