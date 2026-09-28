import "server-only";

import { formatUnits } from "viem";

import { activityFromSwap, netPositions, rankHolders } from "./activity";
import { deployment, uniswapUrl, type ChainId } from "./chains";
import { marketOpen, quoteUsdRate, readFeed } from "./chainlink";
import { presetFromIndex } from "./curves";
import { identicon } from "./identicon";
import { mediaKind, mediaSrc } from "./media";
import {
  fullReserve,
  readBoundaries,
  readCurveStates,
  readFactoryPreset,
  tokenBalances,
  type CurveStateRaw,
  type FactoryPreset,
} from "./onchain";
import type { CurveRow } from "./registry";
import { shortAddress } from "./format";
import {
  changeWithin,
  priceSeries,
  toSwaps,
  totalVolume,
  units,
  volumeWithin,
  DAY_MS,
  type PoolSwap,
} from "./swaps";
import { tradesForCurves } from "./trades";
import type {
  Activity,
  Coin,
  CoinFormat,
  Creator,
  CurveShape,
  FeeSchedule,
  Holder,
  NavReference,
  QuoteToken,
  Tokenomics,
} from "./types";

/**
 * Turns an indexed curve row plus live contract state into the `Coin` the UI
 * renders.
 *
 * The row supplies identity (who launched it, what it is called, its media);
 * the contract supplies every number that moves (price, sold, reserve, fees,
 * graduation); recorded trades supply history (volume, change, chart,
 * holders). Nothing numeric is stored.
 */

export function creatorFromWallet(wallet: string): Creator {
  const short = shortAddress(wallet, 6, 4);
  return {
    handle: short,
    displayName: short,
    avatarUrl: identicon(wallet),
    ticker: short,
    wallet,
    followers: null,
    following: null,
    posts: 0,
    marketCap: 0,
    marketCapCurrency: "USD",
    marketCapChangePct: null,
  };
}

export function quoteOf(row: Pick<CurveRow, "quote" | "quoteSymbol" | "quoteDecimals">): QuoteToken {
  return row.quote
    ? { address: row.quote, symbol: "USDC", decimals: 6 }
    : { address: null, symbol: "ETH", decimals: 18 };
}

function mediaOf(row: CurveRow): Coin["media"] {
  const fallbackArt = identicon(row.token);
  return {
    kind: mediaKind(row.mediaMime),
    url: mediaSrc(row.mediaUrl) ?? fallbackArt,
    posterUrl: mediaSrc(row.posterUrl) ?? mediaSrc(row.mediaUrl) ?? fallbackArt,
    width: row.mediaWidth ?? (row.format === "reel" ? 720 : 1000),
    height: row.mediaHeight ?? (row.format === "reel" ? 1280 : 1000),
  };
}

/** Exponential fee decay, sampled: end + (start - end) · e^(−5t/decay), as `CurveMath.feeBps`. */
export function feeScheduleOf(
  preset: Pick<FactoryPreset, "feeStartBps" | "feeEndBps" | "feeDecaySeconds">,
  launchedAt: number,
  currentBps: number,
  nowSeconds = Math.floor(Date.now() / 1000),
  totalPeriods = 60,
): FeeSchedule {
  const { feeStartBps: start, feeEndBps: end, feeDecaySeconds: decay } = preset;
  const elapsed = Math.max(0, nowSeconds - launchedAt);
  const at = (t: number) => (decay > 0 ? end + (start - end) * Math.exp((-5 * t) / decay) : end);
  const points = Array.from({ length: totalPeriods + 1 }, (_, period) => ({
    period,
    bps: Math.round(at((decay * period) / totalPeriods) * 100) / 100,
  }));
  return {
    currentBps: currentBps,
    startBps: start,
    endBps: end,
    period: decay > 0 ? Math.min(totalPeriods, Math.floor((elapsed / decay) * totalPeriods)) : totalPeriods,
    totalPeriods,
    secondsRemaining: Math.max(0, decay - elapsed),
    points,
    mode: "exponential",
    creatorShare: 0.5,
  };
}

export function tokenomicsOf(state: Pick<CurveStateRaw, "supply" | "curveSupply" | "graduationPrice">, reserveAtFull: bigint | null): Tokenomics {
  const total = units(state.supply, 18);
  const curve = units(state.curveSupply, 18);
  // What `graduate()` pairs with the raised quote: reserve / graduation price.
  const migration =
    reserveAtFull !== null && state.graduationPrice > 0n
      ? Math.min(total - curve, units((reserveAtFull * 10n ** 18n) / state.graduationPrice, 18))
      : total - curve;
  const leftover = Math.max(0, total - curve - migration);
  const pct = (value: number) => (total > 0 ? value / total : 0);
  return {
    totalSupply: total,
    curveAmount: curve,
    migrationAmount: migration,
    leftoverAmount: leftover,
    curvePct: pct(curve),
    migrationPct: pct(migration),
    leftoverPct: pct(leftover),
  };
}

export function shapeOf(
  boundaries: { prices: bigint[]; sizes: bigint[] },
  quoteDecimals: number,
  currentPrice?: bigint,
): CurveShape {
  const sizes = boundaries.sizes.map((size) => units(size, 18));
  const largest = Math.max(...sizes, 0);
  return {
    points: sizes.map((liquidity, index) => ({
      index,
      price: units(boundaries.prices[index], quoteDecimals),
      liquidity,
      weight: largest > 0 ? liquidity / largest : 0,
    })),
    startPrice: units(boundaries.prices[0], quoteDecimals),
    endPrice: units(boundaries.prices[boundaries.prices.length - 1], quoteDecimals),
    currentPrice: currentPrice === undefined ? undefined : units(currentPrice, quoteDecimals),
  };
}

/** A tracker's mark against its Chainlink feed. */
export async function navFor(row: CurveRow, state: CurveStateRaw, rate: number): Promise<NavReference | null> {
  if (!row.feed) return null;
  const reading = await readFeed(row.chainId as ChainId, row.feed).catch(() => null);
  if (!reading) return null;
  const curvePrice = units(state.price, row.quoteDecimals) * rate;
  const bandBps = Number(state.bandBps);
  const ceiling = reading.price * (1 + bandBps / 10_000);
  return {
    source: "chainlink",
    symbol: row.refSymbol ?? "",
    feed: row.feed,
    price: reading.price,
    updatedAt: new Date(reading.updatedAt * 1000).toISOString(),
    ageSeconds: reading.ageSeconds,
    bandBps,
    maxAgeSeconds: Number(state.maxAge),
    marketOpen: marketOpen(reading, Number(state.maxAge)),
    curvePrice,
    deviationPct: reading.price > 0 ? (curvePrice / reading.price - 1) * 100 : null,
    withinBand: curvePrice <= ceiling,
    bandCeiling: ceiling,
  };
}

export type HydrateOptions = {
  /** Fee schedule, tokenomics, curve shape: the coin page's extras. */
  detailed?: boolean;
  /** Price history for the chart. Defaults to `detailed`. */
  history?: boolean;
  /** Tracker NAV without the rest of `detailed`. */
  nav?: boolean;
};

type Loaded = {
  state: CurveStateRaw;
  swaps: PoolSwap[];
  rate: number | null;
  boundaries: { prices: bigint[]; sizes: bigint[] } | null;
  preset: FactoryPreset | null;
};

function compose(row: CurveRow, loaded: Loaded, options: HydrateOptions, nav: NavReference | null): Coin {
  const { state, swaps, boundaries } = loaded;
  const chainId = row.chainId as ChainId;
  const quote = quoteOf(row);
  const rate = loaded.rate ?? 1;
  const currency = loaded.rate === null ? quote.symbol : "USD";

  const priceQuote = units(state.price, quote.decimals);
  const priceUsd = priceQuote * rate;
  const totalSupply = units(state.supply, 18);
  const reserveAtFull = boundaries ? fullReserve(boundaries) : null;
  const progress = state.curveSupply > 0n ? Number((state.sold * 1_000_000n) / state.curveSupply) / 1_000_000 : 0;
  const raised = units(state.quoteReserve, quote.decimals);
  const threshold =
    reserveAtFull !== null
      ? units(reserveAtFull, quote.decimals)
      : progress > 0
        ? raised / progress
        : 0;

  const opening = { price: units(state.p0, quote.decimals), at: row.createdAt.getTime() };
  const change = changeWithin(swaps, DAY_MS, priceQuote, Date.now(), opening);
  const wantHistory = options.history ?? options.detailed ?? false;

  const holdersMap = netPositions(swaps);
  const holders = [...holdersMap.values()].filter((balance) => balance > 1e-9).length;

  const graduated = Boolean(state.graduated);
  const creatorFeesQuote = units(state.creatorFees, quote.decimals);

  return {
    address: row.token,
    chainId,
    format: row.format as CoinFormat,
    name: row.name,
    symbol: row.symbol,
    description: row.description ?? undefined,
    media: mediaOf(row),
    creator: creatorFromWallet(row.creator),
    createdAt: row.createdAt.toISOString(),
    pool: row.curve,
    quote,
    quoteUsdRate: loaded.rate,
    marketCap: priceUsd * totalSupply,
    marketCapCurrency: currency,
    marketCapChangePct: change,
    volume24h: (volumeWithin(swaps, DAY_MS) ?? 0) * rate,
    totalVolume: (totalVolume(swaps) ?? 0) * rate,
    creatorRewards: creatorFeesQuote * rate,
    creatorFeesQuote,
    holders,
    priceUsd,
    priceQuote,
    feeBps: Number(state.feeBps),
    priceHistory: wantHistory
      ? priceSeries(swaps).map((point) => ({ ...point, price: point.price * rate, volume: point.volume * rate }))
      : undefined,
    priceHistoryPartial: wantHistory ? false : undefined,
    nav,
    reference: row.feed ? { source: "chainlink", id: row.refSymbol ?? "", feed: row.feed } : null,
    curve: {
      progress: graduated ? 1 : Math.min(1, progress),
      raisedUsd: raised * rate,
      thresholdUsd: threshold * rate,
      graduated,
    },
    curvePreset: presetFromIndex(row.preset),
    graduatedPool: graduated ? state.pool.toLowerCase() : undefined,
    graduatedUrl: graduated ? uniswapUrl(chainId, row.token, state.pool) : undefined,
    fee:
      options.detailed && loaded.preset
        ? feeScheduleOf(loaded.preset, Number(state.launchedAt), Number(state.feeBps))
        : undefined,
    supply: options.detailed ? tokenomicsOf(state, reserveAtFull) : undefined,
    shape: options.detailed && boundaries ? shapeOf(boundaries, quote.decimals, state.price) : undefined,
  };
}

/**
 * Hydrate many curves for a list: one multicall for their states, one query
 * for their trades. `missing` counts rows the chain would not answer for, so a
 * list that is short says so instead of passing for the whole market.
 */
export async function hydrateCurves(
  rows: CurveRow[],
  options: HydrateOptions = {},
): Promise<{ coins: Coin[]; missing: number }> {
  if (rows.length === 0) return { coins: [], missing: 0 };

  const byChain = new Map<ChainId, CurveRow[]>();
  for (const row of rows) {
    const chainId = row.chainId as ChainId;
    byChain.set(chainId, [...(byChain.get(chainId) ?? []), row]);
  }

  const [statesByChain, trades] = await Promise.all([
    Promise.all(
      [...byChain.entries()].map(async ([chainId, list]) => readCurveStates(chainId, list.map((row) => row.curve))),
    ),
    tradesForCurves(rows.map((row) => row.curve)),
  ]);
  const states = new Map<string, CurveStateRaw | null>();
  for (const map of statesByChain) for (const [curve, state] of map) states.set(curve, state);

  const rates = new Map<string, number | null>();
  for (const symbol of new Set(rows.map((row) => row.quoteSymbol))) {
    rates.set(symbol, await quoteUsdRate(symbol).catch(() => null));
  }

  const out = await Promise.all(
    rows.map(async (row): Promise<Coin | null> => {
      const state = states.get(row.curve);
      if (!state) return null;
      const chainId = row.chainId as ChainId;
      const [boundaries, preset] = await Promise.all([
        readBoundaries(chainId, {
          curve: row.curve,
          preset: row.preset,
          p0: BigInt(row.p0),
          capFp: BigInt(row.capFp),
          curveSupply: BigInt(row.curveSupply),
        }).catch(() => null),
        options.detailed && deployment(chainId)
          ? readFactoryPreset(chainId, row.preset).catch(() => null)
          : Promise.resolve(null),
      ]);
      const loaded: Loaded = {
        state,
        swaps: toSwaps(trades.get(row.curve) ?? [], row.quoteDecimals),
        rate: rates.get(row.quoteSymbol) ?? null,
        boundaries,
        preset,
      };
      const nav =
        row.feed && (options.nav || options.detailed) ? await navFor(row, state, loaded.rate ?? 1).catch(() => null) : null;
      return compose(row, loaded, options, nav);
    }),
  );

  const coins = out.filter((coin): coin is Coin => coin !== null);
  return { coins, missing: rows.length - coins.length };
}

export async function hydrateCurve(row: CurveRow, options: HydrateOptions = {}): Promise<Coin | null> {
  const { coins } = await hydrateCurves([row], options);
  return coins[0] ?? null;
}

/** A curve's recorded trades as swaps, newest first. */
export async function curveSwaps(row: CurveRow): Promise<PoolSwap[]> {
  const trades = await tradesForCurves([row.curve]);
  return toSwaps(trades.get(row.curve) ?? [], row.quoteDecimals);
}

export function curveActivity(swaps: PoolSwap[], rate: number, limit = 20): Activity[] {
  return swaps.slice(0, limit).map((swap) => activityFromSwap(swap, rate));
}

/**
 * The holder book, with live balances.
 *
 * Candidates are every wallet that traded plus the creator; their balances
 * are then read from the token in one multicall, so a holder who received
 * tokens by transfer and sold some is still right. Falls back to the
 * trade-derived net positions when the balance read fails.
 */
export async function holderBook(
  row: CurveRow,
  swaps: PoolSwap[],
): Promise<{ holders: Holder[]; source: "balances" | "trades" }> {
  const chainId = row.chainId as ChainId;
  const candidates = [...new Set([...swaps.map((swap) => swap.trader), row.creator])].filter(
    (wallet) => wallet !== row.curve,
  );
  const balances = await tokenBalances(
    chainId,
    candidates.map((owner) => ({ token: row.token, owner })),
  ).catch(() => null);

  if (balances && balances.every((value) => value !== null)) {
    const map = new Map<string, number>();
    candidates.forEach((wallet, i) => map.set(wallet, Number(formatUnits(balances[i]!, 18))));
    return { holders: rankHolders(map), source: "balances" };
  }
  return { holders: rankHolders(netPositions(swaps)), source: "trades" };
}
