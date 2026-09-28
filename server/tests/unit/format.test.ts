import { describe, expect, it } from "vitest";

import {
  compact,
  percent,
  quoteAmount,
  shortAddress,
  since,
  tokenAmount,
  usd,
} from "@/lib/juno/format";

describe("compact", () => {
  it("keeps three significant figures across magnitudes", () => {
    expect(compact(6730)).toBe("6.73k");
    expect(compact(74_800)).toBe("74.8k");
    expect(compact(748_000)).toBe("748k");
    expect(compact(17_535_191)).toBe("17.5m");
  });

  it("trims trailing zeros rather than padding", () => {
    expect(compact(2_000)).toBe("2k");
    expect(compact(1_500_000)).toBe("1.5m");
  });

  it("leaves sub-thousand values alone", () => {
    expect(compact(999)).toBe("999");
  });
});

describe("usd", () => {
  it("shows exact dollars below 1k and compacts above", () => {
    expect(usd(748.18)).toBe("$748.18");
    expect(usd(469.82)).toBe("$469.82");
    expect(usd(6730)).toBe("$6.73k");
    expect(usd(2020)).toBe("$2.02k");
  });

  it("does not render a dust amount as $0.00", () => {
    // A network fee of a fifth of a cent is real; rounding it to $0.00 would
    // tell the user the trade is free.
    expect(usd(0.0002)).toBe("$0.0002");
    expect(usd(0)).toBe("$0");
  });

  it("carries the sign", () => {
    expect(usd(-1500)).toBe("-$1.5k");
  });
});

describe("tokenAmount", () => {
  it("groups whole amounts and compacts millions", () => {
    expect(tokenAmount(349_674)).toBe("349,674");
    expect(tokenAmount(17_535_191)).toBe("17.5m");
  });
});

describe("quoteAmount", () => {
  it("never falls back to exponent notation", () => {
    expect(quoteAmount(0.0083)).toBe("0.0083");
    expect(quoteAmount(0.00000001)).toBe("<0.0001");
    expect(quoteAmount(0)).toBe("0");
  });
});

describe("since", () => {
  const now = Date.parse("2026-09-16T12:00:00Z");
  const ago = (ms: number) => new Date(now - ms).toISOString();

  it("renders a single unit", () => {
    expect(since(ago(9 * 3600_000), now)).toBe("9h");
    expect(since(ago(3 * 86400_000), now)).toBe("3d");
    expect(since(ago(60 * 86400_000), now)).toBe("2mo");
    expect(since(ago(30_000), now)).toBe("30s");
  });

  it("does not go negative on clock skew", () => {
    expect(since(new Date(now + 5000).toISOString(), now)).toBe("0s");
  });
});

describe("shortAddress", () => {
  it("elides the middle of an address", () => {
    expect(shortAddress("0x1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b", 6, 4)).toBe("0x1a2b…9a0b");
  });

  it("leaves short strings intact", () => {
    expect(shortAddress("abc")).toBe("abc");
  });
});

describe("percent", () => {
  it("is always signed", () => {
    expect(percent(0.0421)).toBe("+4.21%");
    expect(percent(-0.018)).toBe("-1.80%");
  });
});
