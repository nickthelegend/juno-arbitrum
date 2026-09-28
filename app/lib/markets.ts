import { juno, type Coin } from "./api";

/**
 * Which of Juno's two products a coin belongs to.
 *
 * - **post** — someone's photo or reel, launched as a coin on its own curve.
 *   These are the feed and the reels.
 * - **stock** — a tracker: a curve held to a stock's Chainlink price. These
 *   are the Trade tab's Stocks list.
 *
 * The server says so in `reference`: a Chainlink feed for a tracker, null for
 * a post or reel.
 */
export type MarketKind = "post" | "stock";

export function marketKind(coin: Coin): MarketKind {
  return coin.reference ? "stock" : "post";
}

/** A web link to a coin, for the share sheet. The Next app serves the same market. */
export function coinLink(apiUrl: string, coin: { address: string }): string {
  return `${apiUrl}/coin/${coin.address}`;
}

/** 12400 → "12.4K". Counts, not money — no currency and no decimals under a thousand. */
export function count(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1).replace(/\.0$/, "")}K`;
  return String(Math.round(value));
}

/** $950,000,000,000 → "$950B". For valuations, where cents are noise. */
export function bigMoney(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  const abs = Math.abs(value);
  if (abs >= 1e12) return `$${(value / 1e12).toFixed(2).replace(/\.?0+$/, "")}T`;
  if (abs >= 1e9) return `$${(value / 1e9).toFixed(1).replace(/\.0$/, "")}B`;
  if (abs >= 1e6) return `$${(value / 1e6).toFixed(1).replace(/\.0$/, "")}M`;
  if (abs >= 1e3) return `$${(value / 1e3).toFixed(1).replace(/\.0$/, "")}K`;
  return `$${value.toFixed(2)}`;
}

/**
 * Every coin, sorted into Juno's two products in one read.
 *
 * ## Shared for a minute
 *
 * The feed, the reels and the Trade tab all want this same list, and pricing
 * it reads every curve. Read separately, moving between tabs
 * cost the whole walk each time. One in-flight or recent read is shared
 * instead; pull-to-refresh calls `invalidateMarkets()` first, so a deliberate
 * refresh is always a fresh read.
 */
const SHARE_MS = 60_000;
let shared: { key: string; at: number; value: ReturnType<typeof readMarkets> } | null = null;

export function invalidateMarkets() {
  shared = null;
}

export function loadMarkets(viewer?: string | null) {
  const key = viewer ?? "";
  if (shared && shared.key === key && Date.now() - shared.at < SHARE_MS) return shared.value;
  const value = readMarkets(viewer);
  shared = { key, at: Date.now(), value };
  // Aged from when it *landed*: the walk itself can take most of a minute, so
  // timing from the request would expire it about as soon as it arrived.
  // A failed read is not worth sharing; the next caller should try again.
  value.then(
    () => {
      if (shared?.value === value) shared.at = Date.now();
    },
    () => {
      if (shared?.value === value) shared = null;
    },
  );
  return value;
}

async function readMarkets(viewer?: string | null) {
  const { coins, missing } = await juno.coins(undefined, { social: true, viewer, nav: true });
  const sorted = { posts: [] as Coin[], stocks: [] as Coin[] };
  for (const coin of coins) {
    (marketKind(coin) === "post" ? sorted.posts : sorted.stocks).push(coin);
  }
  return { ...sorted, missing };
}

/**
 * "How far to graduation", as text.
 *
 * A curve a hair past zero printed "0.00%" — a figure that reads as zero and
 * as broken at once. Under a hundredth of a percent it says so; under one it
 * keeps two decimals; above that, whole numbers.
 */
export function progressLabel(pct: number): string {
  if (pct <= 0) return "0%";
  if (pct < 0.01) return "<0.01%";
  if (pct < 1) return `${pct.toFixed(2)}%`;
  return `${Math.floor(pct)}%`;
}
