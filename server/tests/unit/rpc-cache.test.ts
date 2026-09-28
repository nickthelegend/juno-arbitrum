import { describe, expect, it, vi } from "vitest";

import { ttlCache } from "@/lib/juno/rpc";

/**
 * The read cache in front of every chain call.
 *
 * The TTL half is ordinary. The half worth a test is what happens to callers
 * that arrive *together*, because that is where the coin page's two halves
 * started disagreeing with each other: the chart and the activity list both
 * wanted the same pool's swap history, both missed an empty cache at the same
 * moment, both read, and the endpoint served one and refused the other. The
 * page then said "trade history could not be read" directly above four trades.
 *
 * Neither sentence was wrong about its own read. Sharing the in-flight promise
 * is what makes them the same read.
 */

/** Resolves only when `release()` is called, so overlap is deterministic. */
function gate<T>() {
  let release!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

describe("ttlCache", () => {
  it("gives concurrent callers one read, not one each", async () => {
    const cache = ttlCache<string>(60_000);
    const first = gate<string>();
    const load = vi.fn(() => first.promise);

    const a = cache.get("pool", load);
    const b = cache.get("pool", load);
    const c = cache.get("pool", load);

    expect(load).toHaveBeenCalledTimes(1);

    first.release("history");
    expect(await Promise.all([a, b, c])).toEqual(["history", "history", "history"]);
  });

  it("serves the cached value once the read has landed", async () => {
    const cache = ttlCache<number>(60_000);
    const load = vi.fn(async () => 7);

    expect(await cache.get("k", load)).toBe(7);
    expect(await cache.get("k", load)).toBe(7);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("re-reads after the entry's own TTL, which the value chooses", async () => {
    vi.useFakeTimers();
    try {
      const cache = ttlCache<{ partial: boolean }>(60_000);
      let call = 0;
      const load = async () => ({ partial: ++call === 1 });
      // A short read is trusted for a moment; a complete one for the full TTL.
      const ttlFor = (value: { partial: boolean }) => (value.partial ? 1_000 : 60_000);

      expect(await cache.get("k", load, ttlFor)).toEqual({ partial: true });
      vi.setSystemTime(Date.now() + 1_500);
      expect(await cache.get("k", load, ttlFor)).toEqual({ partial: false });
      vi.setSystemTime(Date.now() + 1_500);
      // The complete read is still inside its own, longer TTL.
      expect(await cache.get("k", load, ttlFor)).toEqual({ partial: false });
      expect(call).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not pin later callers to a failed read", async () => {
    const cache = ttlCache<string>(60_000);
    let call = 0;
    const load = async () => {
      if (++call === 1) throw new Error("429");
      return "ok";
    };

    await expect(cache.get("k", load)).rejects.toThrow("429");
    // The in-flight entry has to be cleared on rejection too, or every
    // subsequent request for this key replays the same failure forever.
    await expect(cache.get("k", load)).resolves.toBe("ok");
  });

  it("shares in flight per key, not across keys", async () => {
    const cache = ttlCache<string>(60_000);
    const load = vi.fn(async (): Promise<string> => "v");

    await Promise.all([cache.get("a", load), cache.get("b", load)]);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("drops what `invalidate` names and keeps the rest", async () => {
    const cache = ttlCache<number>(60_000);
    let call = 0;
    const load = async () => ++call;

    await cache.get("pool:one", load);
    await cache.get("other:one", load);
    cache.invalidate("pool:");

    expect(await cache.get("pool:one", load)).toBe(3);
    expect(await cache.get("other:one", load)).toBe(2);
  });
});
