import { describe, expect, it } from "vitest";

import { TRACKER_MAX_AGE_SECONDS } from "@config/addresses";
import { TRACKER_DEFAULTS, referencePrice, trackerLaunchParams } from "@/lib/juno/trackers";

/** Tracker launch defaults: the shape rehearsed to trip `OutsideBand` on a ~$9.5k buy. */
describe("trackerLaunchParams", () => {
  const base = {
    symbol: "TSLA",
    metadataURI: "ipfs://x",
    quote: "0x00000000000000000000000000000000000000c3" as const,
    feed: "0x00000000000000000000000000000000000000fe" as const,
    // $361.22 with Chainlink's 8 decimals.
    answer: 36_122_000_000n,
    feedDecimals: 8,
  };

  it("converts the feed answer into USDC units per token", () => {
    expect(referencePrice(36_122_000_000n, 8, 6)).toBe(361_220_000n);
  });

  it("starts at 0.99× the stock with 100 tokens, a 1.04× cap, a 1% band and the staleness window", () => {
    expect(trackerLaunchParams(base)).toEqual({
      name: "TSLA Tracker",
      symbol: "jTSLA",
      metadataURI: "ipfs://x",
      quote: base.quote,
      feed: base.feed,
      bandBps: 100,
      maxAge: TRACKER_MAX_AGE_SECONDS,
      supply: 100n * 10n ** 18n,
      p0: 357_607_800n,
      capFp: 1_040_000_000_000_000_000n,
    });
    expect(TRACKER_DEFAULTS.bandBps).toBe(100);
  });

  it("takes overrides and refuses a feed with no price", () => {
    expect(trackerLaunchParams({ ...base, overrides: { bandBps: 200, startBps: 10_000n } })).toMatchObject({
      bandBps: 200,
      p0: 361_220_000n,
    });
    expect(() => trackerLaunchParams({ ...base, answer: 0n })).toThrow(/no price/);
  });
});
