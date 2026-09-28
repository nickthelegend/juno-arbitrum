/**
 * Juno domain types, as the API returns them.
 *
 * Independent of the contracts' raw shapes: the UI speaks in decoded numbers
 * (whole tokens, whole ETH or USDC, USD) so no component carries a bigint or
 * a decimals conversion. `lib/juno/chain.ts` owns the translation.
 *
 * Conventions: addresses are lowercase; `marketCapChangePct` is a signed
 * ratio (0.012 means +1.2%), as it always was; `nav.deviationPct` is a
 * percent (1.2 means +1.2%).
 */

export type CurvePresetId = "content" | "thin-name" | "ipo-book" | "tight-nav";

export type TradeSide = "buy" | "sell";

export type CoinFormat = "post" | "reel";

export type MediaKind = "image" | "video" | "audio";

export type Media = {
  kind: MediaKind;
  url: string;
  /** Poster frame for video; falls back to `url` for images. */
  posterUrl?: string;
  width: number;
  height: number;
};

export type Creator = {
  handle: string;
  displayName: string;
  avatarUrl: string;
  bio?: string;
  ticker: string;
  wallet: string;
  socials?: { x?: string };
  followers: number | null;
  following: number | null;
  posts: number;
  marketCap: number;
  marketCapCurrency: string;
  marketCapChangePct: number | null;
};

/** The quote asset. `address: null` is native ETH. */
export type QuoteToken = {
  address: string | null;
  symbol: "ETH" | "USDC";
  decimals: 18 | 6;
};

/** What a tracker is marked against. */
export type CoinReference = {
  source: "chainlink";
  id: string;
  feed: string;
};

/**
 * A tracker's live mark against its Chainlink feed.
 *
 * `price` and `curvePrice` are both USD per token (one tracker token stands
 * for one share). `deviationPct` is a signed percent (1.2 = +1.2%): positive
 * means the curve trades above the stock. `marketOpen` is the contract's own rule: the feed
 * answered within `maxAge` seconds (buys revert with `MarketClosed` otherwise;
 * sells always work).
 */
export type NavReference = {
  source: "chainlink";
  symbol: string;
  feed: string;
  price: number;
  updatedAt: string;
  ageSeconds: number;
  bandBps: number;
  maxAgeSeconds: number;
  marketOpen: boolean;
  curvePrice: number;
  deviationPct: number | null;
  /** True while the curve sits at or under the band's ceiling (the contract only caps the upside). */
  withinBand: boolean;
  /** The highest price a buy may leave the curve at, USD per token. */
  bandCeiling: number;
};

/**
 * Progress toward graduation.
 *
 * `progress` is tokens sold over the curve's supply — exactly what the
 * contract checks before `graduate()` is allowed.
 */
export type CurveState = {
  progress: number;
  /** Quote held by the curve (fees excluded), in USD. */
  raisedUsd: number;
  /** Quote the curve holds once full, in USD. */
  thresholdUsd: number;
  graduated: boolean;
};

export type FeePoint = { period: number; bps: number };

export type FeeSchedule = {
  currentBps: number;
  startBps: number;
  endBps: number;
  /** Which of `totalPeriods` sample points `now` falls in. */
  period: number;
  totalPeriods: number;
  secondsRemaining: number;
  points: FeePoint[];
  mode: "exponential";
  /** The creator's share of every fee. */
  creatorShare: number;
};

export type Tokenomics = {
  totalSupply: number;
  /** Sold on the curve before graduation. */
  curveAmount: number;
  /** Paired with the raised quote in the Uniswap v3 position (unused tokens burn). */
  migrationAmount: number;
  leftoverAmount: number;
  curvePct: number;
  migrationPct: number;
  leftoverPct: number;
};

export type CurvePoint = {
  index: number;
  /** Segment start price, quote units per token. */
  price: number;
  /** Tokens this segment sells. */
  liquidity: number;
  /** `liquidity` over the largest segment's, 0..1. */
  weight: number;
};

export type CurveShape = {
  points: CurvePoint[];
  startPrice: number;
  endPrice: number;
  currentPrice?: number;
};

export type PricePoint = {
  t: string;
  price: number;
  /** Quote-denominated size of the trade that set this price. */
  volume: number;
  side: TradeSide;
};

/** A post, a reel or a stock tracker: one token, one curve. */
export type Coin = {
  /** The token address — the canonical id, used in `/coins/[address]`. */
  address: string;
  chainId: number;
  format: CoinFormat;
  name: string;
  symbol: string;
  description?: string;
  media: Media;
  creator: Creator;
  createdAt: string;

  /** The curve contract. */
  pool: string;
  quote: QuoteToken;
  /** USD per quote token (Chainlink ETH/USD; 1 for USDC), or null when no feed answered. */
  quoteUsdRate: number | null;

  marketCap: number;
  marketCapCurrency: string;
  marketCapChangePct: number | null;
  volume24h: number | null;
  totalVolume: number | null;
  /** Unclaimed creator fees, in `marketCapCurrency`. */
  creatorRewards: number;
  /** Unclaimed creator fees in quote units — what `claimCreatorFees()` would pay. */
  creatorFeesQuote: number;
  holders: number | null;

  /** Price of one token in `marketCapCurrency`. */
  priceUsd: number;
  /** Price of one token in quote units (ETH or USDC). */
  priceQuote: number;
  /** Current trading fee, bps. */
  feeBps: number;
  priceHistory?: PricePoint[];
  priceHistoryPartial?: boolean;
  nav?: NavReference | null;
  reference?: CoinReference | null;

  curve: CurveState;
  curvePreset: CurvePresetId;
  likes?: number;
  commentCount?: number;
  viewerLiked?: boolean | null;
  /** The Uniswap v3 pool, once graduated. */
  graduatedPool?: string;
  /** Where to trade it after graduation. */
  graduatedUrl?: string;
  shape?: CurveShape;
  fee?: FeeSchedule | null;
  supply?: Tokenomics | null;
};

export type Activity = {
  id: string;
  side: TradeSide;
  actor: { handle: string; avatarUrl: string };
  wallet: string;
  /** Tokens, whole units. */
  amount: number;
  /** Quote value of the trade, converted to `currency`. */
  valueUsd: number;
  timestamp: string;
  txHash: string;
  logIndex: number;
  blockNumber: number;
};

export type Holder = {
  rank: number;
  actor: { handle: string; avatarUrl: string };
  wallet: string;
  balance: number;
  /** Share of what the list accounts for, 0..1. */
  share: number;
};
