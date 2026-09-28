import { TRACKER_MAX_AGE_SECONDS } from "@config/addresses";

/**
 * Launch parameters for a stock tracker (`factory.launchTracker`).
 *
 * The defaults are the shape that demonstrates the band on-chain (rehearsed
 * on a Sepolia fork): 100 tokens, one per share; the curve runs from 0.99× to
 * 1.04× the stock; the band is 1%, so buys may lift the price to 1.01× and a
 * large one (~$9.5k) reverts `OutsideBand`; and the feed goes stale after
 * `TRACKER_MAX_AGE_SECONDS`, which closes buys but never sells.
 */

export const TRACKER_DEFAULTS = {
  supply: 100n * 10n ** 18n,
  /** p0 = 0.99 × the stock. */
  startBps: 9_900n,
  /** Curve top = 1.04 × p0. */
  capFp: 1_040_000_000_000_000_000n,
  bandBps: 100,
  maxAge: TRACKER_MAX_AGE_SECONDS,
} as const;

export type TrackerLaunchParams = {
  name: string;
  symbol: string;
  metadataURI: string;
  quote: `0x${string}`;
  feed: `0x${string}`;
  bandBps: number;
  maxAge: number;
  supply: bigint;
  p0: bigint;
  capFp: bigint;
};

/** The stock price in quote base units per whole token: answer × 10^quoteDecimals / 10^feedDecimals. */
export function referencePrice(answer: bigint, feedDecimals: number, quoteDecimals = 6): bigint {
  return (answer * 10n ** BigInt(quoteDecimals)) / 10n ** BigInt(feedDecimals);
}

export function trackerLaunchParams(input: {
  symbol: string;
  name?: string;
  metadataURI: string;
  quote: `0x${string}`;
  feed: `0x${string}`;
  answer: bigint;
  feedDecimals: number;
  quoteDecimals?: number;
  overrides?: Partial<Pick<TrackerLaunchParams, "bandBps" | "maxAge" | "supply" | "capFp">> & { startBps?: bigint };
}): TrackerLaunchParams {
  if (input.answer <= 0n) throw new Error("The feed has no price");
  const ref = referencePrice(input.answer, input.feedDecimals, input.quoteDecimals ?? 6);
  const startBps = input.overrides?.startBps ?? TRACKER_DEFAULTS.startBps;
  return {
    name: input.name ?? `${input.symbol} Tracker`,
    symbol: `j${input.symbol}`,
    metadataURI: input.metadataURI,
    quote: input.quote,
    feed: input.feed,
    bandBps: input.overrides?.bandBps ?? TRACKER_DEFAULTS.bandBps,
    maxAge: input.overrides?.maxAge ?? TRACKER_DEFAULTS.maxAge,
    supply: input.overrides?.supply ?? TRACKER_DEFAULTS.supply,
    p0: (ref * startBps) / 10_000n,
    capFp: input.overrides?.capFp ?? TRACKER_DEFAULTS.capFp,
  };
}
