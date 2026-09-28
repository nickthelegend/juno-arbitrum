import { describe, expect, it } from "vitest";

import { ethUsd, readFeed } from "@/lib/juno/chainlink";
import { ONE, stockFeeds } from "@/lib/juno/chains";

/**
 * Read-only checks against Arbitrum One: the real Chainlink feeds the
 * trackers are held to, and ETH/USD. No contracts of Juno's needed.
 */
describe("Arbitrum One Chainlink reads", () => {
  it("reads ETH/USD", async () => {
    const price = await ethUsd();
    expect(price).toBeGreaterThan(100);
    expect(price).toBeLessThan(100_000);
  });

  it("reads each stock feed with 8 decimals and a timestamp", async () => {
    const feeds = stockFeeds(ONE);
    expect(feeds.map((feed) => feed.symbol).sort()).toEqual(["AAPL", "NVDA", "TSLA"]);
    for (const { feed } of feeds) {
      const reading = await readFeed(ONE, feed);
      expect(reading?.decimals).toBe(8);
      expect(reading?.price).toBeGreaterThan(1);
      expect(reading?.updatedAt).toBeGreaterThan(1_700_000_000);
    }
  });

  it("serves them from /api/juno/stocks as a plain array", async () => {
    const { GET } = await import("@/app/api/juno/stocks/route");
    const response = await GET(new Request("http://juno.test/api/juno/stocks?chainId=42161"));
    expect(response.status).toBe(200);
    const body = (await response.json()) as Array<{ symbol: string; price: number; marketOpen: boolean; trackers: unknown[] }>;
    expect(body.map((stock) => stock.symbol).sort()).toEqual(["AAPL", "NVDA", "TSLA"]);
    for (const stock of body) {
      expect(stock.price).toBeGreaterThan(1);
      expect(typeof stock.marketOpen).toBe("boolean");
      expect(stock.trackers).toEqual([]);
    }
  });
});
