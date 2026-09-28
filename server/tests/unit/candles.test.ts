import { describe, it, expect } from "vitest";

import { defaultBucket, toCandles, type Tick } from "../../../app/lib/candles";

/**
 * Candle aggregation.
 *
 * The rule worth testing is not that OHLC is computed — it is that empty
 * buckets are *left* empty. Carrying the last close forward is what every naive
 * implementation does, and on a pool that traded four times it would produce a
 * dense chart of flat candles implying continuous activity that never happened.
 */

const tick = (iso: string, price: number, volume = 1, side: "buy" | "sell" = "buy"): Tick => ({
  t: iso,
  price,
  volume,
  side,
});

describe("toCandles", () => {
  it("builds one candle per bucket with real OHLC", () => {
    const candles = toCandles(
      [
        tick("2026-09-21T10:00:00Z", 10),
        tick("2026-09-21T10:20:00Z", 14),
        tick("2026-09-21T10:40:00Z", 8),
        tick("2026-09-21T10:55:00Z", 12),
      ],
      "1h",
    );

    expect(candles).toHaveLength(1);
    expect(candles[0]).toMatchObject({ open: 10, high: 14, low: 8, close: 12 });
  });

  it("sums quote size into volume rather than counting trades", () => {
    const candles = toCandles(
      [
        tick("2026-09-21T10:00:00Z", 10, 2.5),
        tick("2026-09-21T10:30:00Z", 11, 7.5),
      ],
      "1h",
    );
    expect(candles[0].volume).toBeCloseTo(10, 9);
  });

  it("splits across buckets at the boundary", () => {
    const candles = toCandles(
      [
        tick("2026-09-21T10:59:59Z", 10),
        tick("2026-09-21T11:00:01Z", 20),
      ],
      "1h",
    );
    expect(candles).toHaveLength(2);
    expect(candles[0].close).toBe(10);
    expect(candles[1].open).toBe(20);
  });

  it("leaves quiet periods empty instead of inventing flat candles", () => {
    // Two trades three hours apart. A carried-forward implementation returns
    // four candles, two of them fabricated; the honest answer is two.
    const candles = toCandles(
      [tick("2026-09-21T10:00:00Z", 10), tick("2026-09-21T13:00:00Z", 12)],
      "1h",
    );
    expect(candles).toHaveLength(2);
    expect(candles.map((c) => c.close)).toEqual([10, 12]);
  });

  it("orders buckets oldest first whatever order the ticks arrive in", () => {
    // The RPC returns history newest-first; a chart has to run forwards.
    const candles = toCandles(
      [tick("2026-09-21T13:00:00Z", 12), tick("2026-09-21T10:00:00Z", 10)],
      "1h",
    );
    expect(candles.map((c) => c.at)).toEqual([...candles.map((c) => c.at)].sort((a, b) => a - b));
    expect(candles[0].open).toBe(10);
  });

  it("regroups when the bucket changes", () => {
    // Buckets are floored against the epoch, not against the first tick, so
    // 12:30 and 14:00 share the 12:00-16:00 four-hour bucket while sitting in
    // different hourly ones.
    const ticks = [
      tick("2026-09-21T12:30:00Z", 10),
      tick("2026-09-21T14:00:00Z", 12),
    ];
    expect(toCandles(ticks, "1h")).toHaveLength(2);
    expect(toCandles(ticks, "4h")).toHaveLength(1);
    expect(toCandles(ticks, "4h")[0]).toMatchObject({ open: 10, close: 12, high: 12, low: 10 });
  });

  it("drops ticks that cannot be plotted rather than skewing the scale", () => {
    // A zero or negative price is not a fill; a bad timestamp has no bucket.
    const candles = toCandles(
      [
        tick("2026-09-21T10:00:00Z", 10),
        tick("2026-09-21T10:10:00Z", 0),
        tick("not-a-date", 11),
        tick("2026-09-21T10:20:00Z", Number.NaN),
      ],
      "1h",
    );
    expect(candles).toHaveLength(1);
    expect(candles[0]).toMatchObject({ open: 10, high: 10, low: 10, close: 10 });
  });

  it("returns nothing for no ticks", () => {
    expect(toCandles([], "1h")).toEqual([]);
  });

  it("gives a single trade a valid flat candle", () => {
    // Open, high, low and close are all the one price actually paid. That is a
    // doji, and the renderer floors its body height so it stays visible.
    const candles = toCandles([tick("2026-09-21T10:00:00Z", 7, 3)], "1h");
    expect(candles[0]).toMatchObject({ open: 7, high: 7, low: 7, close: 7, volume: 3 });
  });
});

describe("defaultBucket", () => {
  it("picks a fine bucket for trades minutes apart", () => {
    // Four trades inside a quarter of an hour. An hourly default renders them
    // as one fat candle that shows nothing, which is what shipped first.
    const ticks = [
      tick("2026-09-18T06:03:45Z", 1),
      tick("2026-09-18T06:04:15Z", 1),
      tick("2026-09-18T06:10:59Z", 1),
      tick("2026-09-18T06:17:23Z", 1),
    ];
    expect(defaultBucket(ticks)).toBe("5m");
    expect(toCandles(ticks, defaultBucket(ticks)).length).toBeGreaterThan(1);
  });

  it("widens for a long history rather than producing a dense strip", () => {
    const ticks = Array.from({ length: 30 }, (_, i) =>
      tick(new Date(Date.UTC(2026, 0, 1 + i * 12)).toISOString(), 1),
    );
    expect(["1d", "1w"]).toContain(defaultBucket(ticks));
  });

  it("falls back for a history too short to measure", () => {
    expect(defaultBucket([])).toBe("1h");
    expect(defaultBucket([tick("2026-09-18T06:00:00Z", 1)])).toBe("1h");
  });
});
