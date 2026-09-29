import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Mirroring Chainlink's Arbitrum One stock feeds onto the Sepolia mocks: a
 * mirror is rewritten (answer and timestamp, exactly) only when the real price
 * moved 0.5% or its timestamp is 4 hours ahead.
 */

const REAL = "0x00000000000000000000000000000000000000a1";
const MOCK = "0x00000000000000000000000000000000000000b1";
const reads = new Map<string, [bigint, bigint, bigint, bigint, bigint]>();
const writeContract = vi.fn(async () => "0xhash");

vi.mock("@/lib/juno/chains", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/juno/chains")>();
  return {
    ...actual,
    stockFeeds: (chainId: number) => [{ symbol: "TSLA", feed: chainId === actual.ONE ? REAL : MOCK }],
    publicClient: () => ({
      readContract: async ({ address }: { address: string }) => reads.get(address)!,
      waitForTransactionReceipt: async () => ({ status: "success" }),
    }),
    rpcUrls: () => ["http://localhost:1"],
  };
});
vi.mock("viem", async (importOriginal) => ({ ...(await importOriginal<typeof import("viem")>()), createWalletClient: () => ({ writeContract }) }));

const { mirrorFeeds } = await import("@/lib/juno/mirror-feeds");
const KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const round = (answer: bigint, updatedAt: bigint) => [1n, answer, updatedAt, updatedAt, 1n] as [bigint, bigint, bigint, bigint, bigint];

beforeEach(() => writeContract.mockClear());

describe("mirrorFeeds", () => {
  it("copies the real answer and timestamp when the price moved 0.5% or more", async () => {
    reads.set(REAL, round(35_467_000_000n, 2_000_000n));
    reads.set(MOCK, round(35_753_500_000n, 1_999_000n)); // 0.80% apart, 1000 s behind
    expect(await mirrorFeeds(KEY, 421614)).toEqual([{ symbol: "TSLA", hash: "0xhash" }]);
    expect(writeContract).toHaveBeenCalledWith(expect.objectContaining({ address: MOCK, functionName: "setAnswer", args: [35_467_000_000n, 2_000_000n] }));
  });

  it("copies it when the real feed is 4 hours ahead, even without a move", async () => {
    reads.set(REAL, round(35_467_000_000n, 2_000_000n + 4n * 3600n));
    reads.set(MOCK, round(35_467_000_000n, 2_000_000n));
    await mirrorFeeds(KEY, 421614);
    expect(writeContract).toHaveBeenCalledTimes(1);
  });

  it("leaves a mirror within 0.5% and 4 hours alone, and never writes an identical round", async () => {
    reads.set(REAL, round(35_467_000_000n, 2_000_000n + 3600n));
    reads.set(MOCK, round(35_500_000_000n, 2_000_000n));
    expect(await mirrorFeeds(KEY, 421614)).toEqual([]);
    reads.set(MOCK, round(35_467_000_000n, 2_000_000n + 3600n));
    expect(await mirrorFeeds(KEY, 421614)).toEqual([]);
    expect(writeContract).not.toHaveBeenCalled();
  });
});
