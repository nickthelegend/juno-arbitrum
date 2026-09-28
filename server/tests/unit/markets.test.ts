import { describe, expect, it, vi } from "vitest";

// `app/lib/markets` imports the API client for `loadMarkets`, which pulls in
// Expo modules that do not load under Node. The helpers tested here never call it.
vi.mock("../../../app/lib/api", () => ({ juno: {} }));

import type { Coin } from "../../../app/lib/api";
import { bigMoney, count, marketKind, progressLabel } from "../../../app/lib/markets";

const coin = (over: Record<string, unknown>): Coin => ({ address: "0xa", name: "Something", ...over }) as unknown as Coin;

/** Sorting coins into Juno's two products, and the labels the lists print. */
describe("marketKind", () => {
  it("trusts the server's Chainlink reference", () => {
    expect(marketKind(coin({ reference: null }))).toBe("post");
    expect(marketKind(coin({ reference: { source: "chainlink", id: "TSLA", feed: "0xfeed" } }))).toBe("stock");
  });

  it("treats a coin with no reference field as a post", () => {
    expect(marketKind(coin({}))).toBe("post");
  });
});

describe("progressLabel", () => {
  it("never prints a started curve as 0.00%", () => {
    expect(progressLabel(0)).toBe("0%");
    expect(progressLabel(0.004)).toBe("<0.01%");
    expect(progressLabel(0.42)).toBe("0.42%");
    expect(progressLabel(37.9)).toBe("37%");
  });
});

describe("count and bigMoney", () => {
  it("compacts without inventing precision", () => {
    expect(count(999)).toBe("999");
    expect(count(1000)).toBe("1K");
    expect(count(29_800)).toBe("29.8K");
    expect(count(null)).toBe("");
    expect(bigMoney(950_000_000_000)).toBe("$950B");
    expect(bigMoney(14_000_000_000)).toBe("$14B");
    expect(bigMoney(null)).toBe("—");
  });
});
