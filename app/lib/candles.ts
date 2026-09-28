/**
 * OHLC aggregation.
 *
 * Pure, with no React Native imports, so it can be tested directly — the rule
 * it encodes is the kind that fails silently in a renderer.
 *
 * Nothing streams OHLC for a Juno pool: there is no exchange behind it and no
 * indexer in front of it. What exists is every executed swap, decoded from the
 * pool's vault deltas, and a candle is those swaps grouped by time — first
 * price open, last close, extremes high and low, quote size summed into volume.
 * Real candles over real fills, not a shape fitted to a line.
 */

export type Tick = { t: string; price: number; volume: number; side: "buy" | "sell" };

export type Bucket = "5m" | "1h" | "4h" | "1d" | "1w";

export const BUCKETS: { id: Bucket; label: string }[] = [
  { id: "5m", label: "5m" },
  { id: "1h", label: "1h" },
  { id: "4h", label: "4h" },
  { id: "1d", label: "24h" },
  { id: "1w", label: "1w" },
];

export const SIZE_MS: Record<Bucket, number> = {
  "5m": 5 * 60_000,
  "1h": 3_600_000,
  "4h": 4 * 3_600_000,
  "1d": 86_400_000,
  "1w": 7 * 86_400_000,
};

export type Candle = {
  at: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

/**
 * Group ticks into candles.
 *
 * **Empty buckets are omitted, not filled.** Carrying the last close forward is
 * what a naive implementation does, and on a pool that traded four times it
 * manufactures a dense run of flat candles implying continuous activity that
 * never happened. A gap is the truthful rendering, and it is also why the
 * volume strip rather than the candle bodies is where liquidity is read.
 */
export function toCandles(ticks: Tick[], bucket: Bucket): Candle[] {
  const size = SIZE_MS[bucket];
  const byBucket = new Map<number, Tick[]>();

  for (const tick of ticks) {
    const at = Date.parse(tick.t);
    // A zero or negative price is not a fill, and a bad timestamp has no
    // bucket — both would skew the scale rather than add information.
    if (!Number.isFinite(at)) continue;
    if (!Number.isFinite(tick.price) || tick.price <= 0) continue;

    const key = Math.floor(at / size) * size;
    const list = byBucket.get(key);
    if (list) list.push(tick);
    else byBucket.set(key, [tick]);
  }

  return [...byBucket.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([at, group]) => {
      // The RPC returns history newest-first; a candle has to run forwards.
      const ordered = [...group].sort((x, y) => Date.parse(x.t) - Date.parse(y.t));
      const prices = ordered.map((tick) => tick.price);
      return {
        at,
        open: prices[0],
        close: prices[prices.length - 1],
        high: Math.max(...prices),
        low: Math.min(...prices),
        volume: ordered.reduce((sum, tick) => sum + (Number.isFinite(tick.volume) ? tick.volume : 0), 0),
      };
    });
}


/**
 * The bucket that makes a given history legible.
 *
 * A fixed default is wrong at both ends: an hour bucket collapses four trades
 * made in ten minutes into one fat candle that shows nothing, and a five-minute
 * bucket spreads a year of history into a strip too dense to read. Choosing
 * from the span aims for a handful of candles — enough to have a shape, few
 * enough that each one is still a candle rather than a line.
 */
export function defaultBucket(ticks: Tick[]): Bucket {
  if (ticks.length < 2) return "1h";

  const times = ticks
    .map((tick) => Date.parse(tick.t))
    .filter((at) => Number.isFinite(at))
    .sort((a, b) => a - b);
  if (times.length < 2) return "1h";

  const span = times[times.length - 1] - times[0];
  // Aim for roughly this many candles across the whole history.
  const target = 12;
  const ideal = span / target;

  const order: Bucket[] = ["5m", "1h", "4h", "1d", "1w"];
  let best: Bucket = "5m";
  for (const bucket of order) {
    if (SIZE_MS[bucket] <= ideal) best = bucket;
  }
  return best;
}
