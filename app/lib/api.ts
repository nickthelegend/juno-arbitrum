import Constants from "expo-constants";
import { File as DeviceFile } from "expo-file-system";

import { CHAIN_ID, explorer } from "./chain";

/**
 * The Juno API client.
 *
 * Every read and every transaction comes from the Next.js app. The phone never
 * encodes calldata itself: it asks the server for the steps (`to`, `data`,
 * `value`), sends them from the Privy wallet, and tells the server the hash of
 * what landed (`tx/record`). The contract is `docs/API.md`.
 *
 * ## Finding the server from a simulator
 *
 * `localhost` inside an iOS Simulator is the simulator, not the Mac running the
 * dev server, so a hardcoded localhost fails in exactly the environment this
 * app is demoed in. Expo already knows the host it was served from
 * (`hostUri`), which is the machine running Metro — and that is the same
 * machine running Next. So the default is derived rather than guessed, and
 * `EXPO_PUBLIC_API_URL` overrides it for a deployed backend.
 */

function inferredHost(): string | null {
  const hostUri =
    Constants.expoConfig?.hostUri ??
    // Older/dev-client shapes keep it in different places.
    (Constants.expoGoConfig as { debuggerHost?: string } | undefined)?.debuggerHost;
  if (!hostUri) return null;
  const host = hostUri.split(":")[0];
  if (!host) return null;
  return `http://${host}:3000`;
}

export const API_URL =
  process.env.EXPO_PUBLIC_API_URL?.replace(/\/$/, "") ??
  inferredHost() ??
  "http://localhost:3000";

export class ApiError extends Error {
  readonly status: number;
  /** A request abandoned at its timeout, as opposed to one that never connected. */
  timedOut = false;
  /** The parsed error body, when there was one. */
  body: unknown = null;
  constructor(message: string, status: number, body: unknown = null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

/** The faucet said "not yet". `retryAfterSeconds` is null when it did not say how long. */
export class FaucetLimited extends ApiError {
  readonly retryAfterSeconds: number | null;
  constructor(retryAfterSeconds: number | null) {
    super(
      retryAfterSeconds
        ? `The faucet already sent to this wallet. Try again in ${waitText(retryAfterSeconds)}.`
        : "The faucet already sent to this wallet. Try again later.",
      429,
    );
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

function waitText(seconds: number): string {
  if (seconds < 90) return `${Math.max(1, Math.round(seconds))} seconds`;
  if (seconds < 90 * 60) return `${Math.round(seconds / 60)} minutes`;
  const hours = seconds / 3600;
  return `${hours < 10 ? hours.toFixed(1).replace(/\.0$/, "") : Math.round(hours)} hours`;
}

/**
 * One request.
 *
 * A phone loses its network mid-request far more often than a browser does, so
 * a timeout is mandatory rather than optional: without one a dropped connection
 * leaves a spinner on screen forever with nothing to cancel it.
 */
async function request<T>(
  path: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<T> {
  try {
    return await attempt<T>(path, init);
  } catch (error) {
    /*
     * One quiet retry for a read that never got an answer.
     *
     * A dropped connection — a proxy recycling, a phone changing networks —
     * surfaces as a fetch that throws before any response, and the coin page a
     * launch lands on showed "Could not reach Juno" for a server that answered
     * the retry in under a second. Reads only: a POST may have reached the
     * server, and repeating a transaction submit is not a retry.
     */
    const method = (init.method ?? "GET").toUpperCase();
    if (method !== "GET" || !(error instanceof ApiError) || error.status !== 0 || error.timedOut) {
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 700));
    return attempt<T>(path, init);
  }
}

async function attempt<T>(
  path: string,
  init: RequestInit & { timeoutMs?: number },
): Promise<T> {
  const { timeoutMs = 45_000, ...rest } = init;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${API_URL}${path}`, {
      ...rest,
      signal: controller.signal,
      headers: {
        accept: "application/json",
        ...(rest.body ? { "content-type": "application/json" } : {}),
        ...rest.headers,
      },
    });

    const text = await response.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      // A non-JSON body from a 500 is still worth surfacing as a message.
      if (!response.ok) throw new ApiError(text.slice(0, 200) || "Request failed", response.status);
      throw new ApiError("The server sent something that was not JSON", response.status);
    }

    if (!response.ok) {
      const message =
        (body as { error?: string } | null)?.error ?? `Request failed (${response.status})`;
      throw new ApiError(message, response.status, body);
    }

    return body as T;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      const timedOut = new ApiError("The request timed out. Check your connection.", 0);
      timedOut.timedOut = true;
      throw timedOut;
    }
    throw new ApiError(
      `Could not reach Juno at ${API_URL}. Is the server running?`,
      0,
    );
  } finally {
    clearTimeout(timer);
  }
}

export const api = {
  get: <T>(path: string, timeoutMs?: number) => request<T>(path, { timeoutMs }),
  post: <T>(path: string, body: unknown, timeoutMs?: number) =>
    request<T>(path, { method: "POST", body: JSON.stringify(body), timeoutMs }),
  patch: <T>(path: string, body: unknown, timeoutMs?: number) =>
    request<T>(path, { method: "PATCH", body: JSON.stringify(body), timeoutMs }),
};

/* ------------------------------------------------------------------ */
/* Shapes, mirroring the server's own types                            */
/* ------------------------------------------------------------------ */

export type CurveState = {
  progress: number;
  raisedUsd: number;
  thresholdUsd: number;
  graduated: boolean;
};

/**
 * A stock tracker's reference: the Chainlink feed its curve is held to.
 *
 * The curve contract reads the same feed on every buy and reverts one that
 * would leave the price outside `bandBps`, or any buy at all once the feed is
 * older than its max age (`marketOpen: false`). Sells are never blocked.
 */
export type NavReference = {
  source: "chainlink";
  /** "TSLA". */
  symbol: string;
  /** The feed's price, USD. */
  price: number;
  updatedAt: string;
  ageSeconds: number;
  bandBps: number;
  marketOpen: boolean;
  /** The curve's own price now, in the same units. */
  curvePrice: number;
  /** How far the curve sits from the stock, in percent: 1.2 is 1.2% above. */
  deviationPct: number | null;
};

export type QuoteAsset = {
  /** Null is native ETH. */
  address: string | null;
  symbol: "ETH" | "USDC";
  decimals: 18 | 6;
};

export type Coin = {
  address: string;
  format: "post" | "reel";
  name: string;
  symbol: string;
  description?: string;
  media: { kind: "image" | "video"; url: string; posterUrl?: string; width: number; height: number };
  creator: { handle: string; displayName: string; avatarUrl: string; wallet: string };
  createdAt: string;
  /** The curve contract. `address` is the token, the coin's id everywhere. */
  pool: string;
  chainId: number;
  quote: QuoteAsset;
  /** The Uniswap v3 pool, once the curve has graduated. */
  graduatedPool?: string | null;
  /**
   * USD price of one quote token, or null when no feed answered.
   *
   * Quote-denominated figures — a recurring-buy amount, a contribution — are
   * signed for in quote units; this is what converts them for display, and
   * null has to stay null rather than collapsing to one-to-one.
   */
  quoteUsdRate: number | null;
  marketCap: number;
  marketCapCurrency: string;
  marketCapChangePct: number | null;
  volume24h: number | null;
  totalVolume: number | null;
  creatorRewards: number;
  holders: number | null;
  priceUsd: number;
  priceHistory?: Array<{ t: string; price: number; volume: number; side: "buy" | "sell" }>;
  /** The swap read was cut short — the ticks above are a prefix, not the history. */
  priceHistoryPartial?: boolean;
  nav?: NavReference | null;
  curve: CurveState;
  curvePreset: string;
  /** What the market is held to: a Chainlink feed for a stock tracker, null for a post or reel. */
  reference?: { source: "chainlink"; id: string; feed: string } | null;
  /** Present when the list was asked for `social=1`. */
  likes?: number;
  commentCount?: number;
  viewerLiked?: boolean | null;
};

export type Activity = {
  id: string;
  side: "buy" | "sell";
  actor: { handle: string; avatarUrl: string };
  /** Who signed it. The handle is a shortened form of this, not a key. */
  wallet: string;
  amount: number;
  valueUsd: number;
  timestamp: string;
  txHash?: string;
  logIndex?: number;
  blockNumber?: number;
};

export type Holder = {
  rank: number;
  actor: { handle: string; avatarUrl: string };
  wallet: string;
  balance: number;
  share: number;
};

export type FeedItem =
  | {
      kind: "trade";
      id: string;
      timestamp: string;
      side: "buy" | "sell";
      amount: number;
      valueUsd: number;
      price: number;
      priceNow: number | null;
      currency: string;
      txHash?: string;
      /** What the trader said about this fill when they signed it, if anything. */
      note: string | null;
      actor: { wallet: string; handle: string; avatarUrl: string };
      coin: {
        address: string;
        name: string;
        symbol: string;
        mediaUrl: string | null;
        mediaKind: string;
        posterUrl: string | null;
      };
    }
  | {
      kind: "post";
      id: string;
      timestamp: string;
      body: string;
      author: { wallet: string; handle: string; avatarUrl: string };
      mediaUrl: string | null;
      mediaKind: string | null;
      replyCount: number;
      /** The market this post is about, priced. Price is null when unread. */
      coin: {
        address: string;
        name: string;
        symbol: string;
        priceUsd: number | null;
        currency: string;
        changePct: number | null;
        progress: number | null;
        graduated: boolean;
        /** Null when the holder read was refused — not "held by nobody". */
        holders: number | null;
      } | null;
    };

export type PositionTrade = { t: string; side: "buy" | "sell"; base: number; price: number };

export type Position = {
  baseMint: string;
  poolAddress: string;
  name: string;
  symbol: string;
  mediaUrl: string | null;
  mediaMime: string | null;
  curvePreset: string;
  balance: number;
  price: number;
  value: number;
  averageCost: number | null;
  unrealisedPnl: number | null;
  unrealisedPnlPct: number | null;
  realisedPnl: number;
  currency: string;
  graduated: boolean;
  trades: PositionTrade[];
};

export type Portfolio = {
  wallet: string;
  positions: Position[];
  /** Null when the pool walk did not finish and found nothing — not "$0". */
  totalValue: number | null;
  totalPnl: number | null;
  totalPnlPct: number | null;
  currency: string;
  partial: boolean;
  /** What the wallet was worth at each moment it traded, oldest first. */
  history: Array<{ t: string; value: number }>;
};

export type PostDetail = {
  id: string;
  body: string;
  timestamp: string;
  author: { wallet: string; handle: string; avatarUrl: string };
  mediaUrl: string | null;
  mediaKind: string | null;
};

/** A comment on a coin. `side` and the tx hash are set when it came with a trade. */
export type CoinComment = {
  id: string;
  coinMint: string;
  wallet: string;
  body: string;
  side?: "buy" | "sell";
  /** The trade's transaction hash. Named `signature` in the stored row. */
  signature?: string;
  txHash?: string;
  createdAt: string;
};

/** Who else is in this market, derived from the fills the chart is drawn from. */
export type Crowd = {
  /** USD per quote token, or 1 when no feed answered. Flow figures are in quote units. */
  quoteUsdRate: number;
  traders: number;
  holdersStill: number;
  firstBuyer: {
    wallet: string;
    price: number;
    timestamp: string;
    multiple: number | null;
  } | null;
  netFlow24h: number;
  netFlow7d: number;
  fills24h: number;
  biggestBuy: number | null;
  /** The swap walk was cut short — these are floors, not totals. */
  partial: boolean;
};

export type DepthPoint = {
  amountIn: number;
  amountOut: number;
  averagePrice: number;
  /** Total shortfall against spot, fee included. */
  priceImpact: number;
  /** The part the curve caused, fee excluded. */
  curveImpact: number;
  fee: number;
};

/** One transaction the server built, for the wallet to send in order. */
export type TxStep = {
  /** "Approve USDC", "Buy", "Launch". */
  label: string;
  to: string;
  data: string;
  /** Wei, as a decimal string. */
  value: string;
  /** Padded gas limit, decimal string, when the server set one. */
  gas?: string;
};

export type TxBuild<Q = Record<string, unknown>> = {
  chainId: number;
  steps: TxStep[];
  quote: Q;
};

/** What `tx/record` read from a confirmed receipt. */
export type TxRecord = {
  ok: boolean;
  launched?: { token: string; curve: string };
  trades: number;
};

export type SwapQuote = {
  /** Tokens on a buy, quote asset on a sell. */
  amountOut: number;
  minimumAmountOut: number;
  fee: number;
  priceImpact: number;
  /** Exact-out buys only: expected cost, and the most the transaction may spend. */
  amountIn?: number;
  maximumAmountIn?: number;
  /** Trackers: the buy keeps the price inside the band. Always true for a post. */
  bandOk?: boolean;
  /** Trackers: the feed is fresh, so buys are open. Always true for a post. */
  marketOpen?: boolean;
  /** The band, when this is a tracker. */
  bandBps?: number;
  priceAfter?: number;
  refPrice?: number;
};

export type SwapBuild = TxBuild<SwapQuote> & {
  quoteSymbol?: string;
  quoteUsdRate?: number | null;
  symbol?: string;
};

/** The launch presets the app offers. `tight-nav` is for trackers, which scripts launch. */
export type LaunchPreset = "content" | "thin-name" | "ipo-book";

/** A stock reference and the Juno trackers held to it. */
export type StockReference = {
  symbol: string;
  name: string;
  feed: string;
  price: number | null;
  updatedAt: string | null;
  ageSeconds: number | null;
  marketOpen: boolean;
  trackers: Coin[];
};

export type Balances = {
  eth: number | null;
  usdc: number | null;
  /** One token's balance, when asked for with `token`. */
  token: number | null;
};

/* ------------------------------------------------------------------ */
/* Social trading and savings                                          */
/* ------------------------------------------------------------------ */

export type Trader = {
  wallet: string;
  /** Profit already taken. The rank is on this and nothing else. */
  realised: number;
  /** Open position against cost. Null when the buys predate the read window. */
  unrealised: number | null;
  trades: number;
  coins: number;
  /** Null when no sell had a cost to compare against — unmeasured, not zero. */
  winRate: number | null;
  bestExit: number | null;
  holding: number;
  isCreator: boolean;
  followers: number;
};

export type WatchItem = {
  baseMint: string;
  watchedAt: string;
  alertPrice: number | null;
  /** Null when the coin could not be priced: an alert cannot be judged against a price nobody read. */
  alertCrossed: "up" | "down" | null;
  coin: {
    address: string;
    name: string;
    symbol: string;
    priceUsd: number;
    marketCap: number;
    currency: string;
    changePct: number | null;
    progress: number;
    graduated: boolean;
    media: { kind: "image" | "video"; url: string; posterUrl?: string };
  } | null;
};

export type Plan = {
  id: string;
  baseMint: string;
  amount: number;
  cadence: "daily" | "weekly" | "monthly";
  target: number | null;
  /** Only moves when a swap confirms — a record of transactions, not intentions. */
  contributed: number;
  fills: number;
  lastFilledAt: string | null;
  nextDueAt: string;
  due: boolean;
  active: boolean;
  /**
   * `amount`, `target` and `contributed` are **quote-token units** — ETH or
   * USDC, whatever this pool is priced in, because that is what a buy is
   * signed for. `quoteSymbol` labels them; `quoteUsdRate` converts them, and
   * is null when no feed answered.
   */
  coin: {
    address: string;
    name: string;
    symbol: string;
    priceUsd: number;
    currency: string;
    quoteSymbol: string;
    quoteUsdRate: number | null;
    media?: { kind: "image" | "video"; url: string; posterUrl?: string };
  } | null;
};

/* ------------------------------------------------------------------ */
/* Calls                                                               */
/* ------------------------------------------------------------------ */

export const juno = {
  /** Traders ranked by profit taken. `partial` when the walk came back short. */
  leaderboard: (limit = 20) =>
    api.get<{
      chainId?: number;
      partial: boolean;
      poolsRead: number;
      /** What the registry holds, so `poolsRead` can be read against something. */
      poolsTotal: number;
      traders: Trader[];
    }>(
      `/api/juno/leaderboard?limit=${limit}`,
    ),

  followStats: (wallet: string, viewer?: string | null) =>
    api.get<{
      wallet: string;
      followers: number;
      following: number;
      /** Null when there is no viewer — different from "does not follow". */
      viewerFollows: boolean | null;
      followingList: string[];
    }>(`/api/juno/follow?wallet=${wallet}${viewer ? `&viewer=${viewer}` : ""}`),

  setFollow: (follower: string, target: string, on: boolean) =>
    api.post<{ target: string; isFollowing: boolean; followers: number; following: number }>(
      "/api/juno/follow",
      { follower, target, follow: on },
    ),

  /**
   * This wallet's relationship to one coin — watching, alert, plans.
   *
   * Postgres only. The list endpoints answer the same questions but hydrate
   * every pool from the chain to do it, which the coin screen cannot afford to
   * wait for just to decide what a button says.
   */
  saved: (wallet: string, baseMint: string) =>
    api.get<{
      wallet: string;
      baseMint: string;
      watching: boolean;
      alertPrice: number | null;
      /** The price when the alert was set — the direction is derived from it. */
      alertSetAtPrice: number | null;
      plans: Omit<Plan, "coin">[];
    }>(`/api/juno/saved?wallet=${wallet}&baseMint=${baseMint}`),

  watchlist: (wallet: string) =>
    api.get<{ wallet: string; items: WatchItem[]; missing: number }>(
      `/api/juno/watchlist?wallet=${wallet}`,
    ),

  setWatch: (input: {
    wallet: string;
    baseMint: string;
    watch: boolean;
    alertPrice?: number;
    priceNow?: number;
  }) => api.post<{ baseMint: string; watching: boolean }>("/api/juno/watchlist", input),

  plans: (wallet: string) =>
    api.get<{ wallet: string; plans: Plan[]; missing: number }>(`/api/juno/plans?wallet=${wallet}`),

  createPlan: (input: {
    wallet: string;
    baseMint: string;
    amount: number;
    cadence: "daily" | "weekly" | "monthly";
    target?: number | null;
  }) => api.post<{ id: string }>("/api/juno/plans", input),

  /** Called only after a swap confirms, so progress records real transactions. */
  recordContribution: (id: string, contributed: number) =>
    api.patch<{ plan: Plan }>("/api/juno/plans", { id, contributed }),

  setPlanActive: (id: string, active: boolean) =>
    api.patch<{ id: string; active: boolean }>("/api/juno/plans", { id, active }),

  /**
   * The feed, optionally narrowed to wallets `following` follows.
   *
   * Filtered server-side: a client cannot know how many rows to ask for to be
   * sure the filter has something to work with.
   */
  feed: (limit = 40, following?: string) =>
    api.get<{
      chainId?: number;
      items: FeedItem[];
      /** The trade half came back short — not every trade there is. */
      tradesPartial: boolean;
      scope: "everyone" | "following";
      /** How many wallets the following feed covers. Null on the everyone feed. */
      followingCount: number | null;
    }>(
      `/api/juno/feed?limit=${limit}${following ? `&following=${following}` : ""}`,
    ),

  coins: (
    sort?: "marketCap" | "graduating",
    extra?: {
      /** Likes and comment counts too, and whether `viewer` liked each. */
      social?: boolean;
      viewer?: string | null;
      /** Each tracker's Chainlink reference. */
      nav?: boolean;
    },
  ) =>
    api.get<{
      chainId?: number;
      coins: Coin[];
      /** Registry rows the server could not price — the list is short by this many. */
      missing: number;
    }>(
      `/api/juno/coins?limit=40${sort ? `&sort=${sort}` : ""}${
        extra?.social ? `&social=1${extra.viewer ? `&viewer=${extra.viewer}` : ""}` : ""
      }${extra?.nav ? "&nav=1" : ""}`,
    ),

  /** The Chainlink stock references, each with the trackers held to it. */
  stocks: async () => {
    const body = await api.get<StockReference[] | { stocks?: StockReference[]; references?: StockReference[] }>(
      "/api/juno/stocks",
    );
    return Array.isArray(body) ? body : (body.stocks ?? body.references ?? []);
  },

  /** Like counts for a page of coins, and whether `viewer` liked each. */
  likes: (coins: string[], viewer?: string | null) =>
    api.get<{ counts: Record<string, { likes: number; comments: number; viewerLiked: boolean | null }> }>(
      `/api/juno/likes?coins=${coins.join(",")}${viewer ? `&viewer=${viewer}` : ""}`,
    ),

  setLike: (input: { coin: string; wallet: string; like: boolean }) =>
    api.post<{ coin: string; likes: number; liked: boolean }>("/api/juno/likes", input),

  coin: (token: string) =>
    api.get<{
      chainId?: number;
      coin: Coin;
      activity: Activity[];
      /** The swap walk was cut short — an empty `activity` is not "no trades". */
      activityPartial: boolean;
      holders: Holder[];
      /** The holder read was refused — an empty `holders` is not "no holders". */
      holdersUnreadable: boolean;
      /** Null when the swap history could not be read at all — not "nobody traded". */
      crowd: Crowd | null;
      /** The launch transaction's hash. */
      launchTxHash?: string | null;
    }>(`/api/juno/coins/${token.toLowerCase()}`),

  portfolio: (wallet: string) => api.get<Portfolio>(`/api/juno/portfolio/${wallet}`),

  /** Comments on a coin, newest first. */
  comments: (mint: string) =>
    api.get<{ comments: CoinComment[] }>(`/api/juno/comments?coin=${mint}`),

  /**
   * Say something about a coin — optionally alongside a trade you just made.
   *
   * `side` and `txHash` are what turn a comment into an announcement: the
   * row then carries which way you went and the transaction that proves it,
   * so the claim is checkable rather than asserted.
   */
  addComment: (input: {
    coin: string;
    wallet: string;
    body: string;
    side?: "buy" | "sell";
    txHash?: string;
  }) =>
    api.post<{ comment: CoinComment }>("/api/juno/comments", {
      ...input,
      // The stored row keeps the field name it has always had.
      ...(input.txHash ? { signature: input.txHash } : {}),
    }),

  /**
   * What this curve can absorb, and the largest trade inside an impact budget.
   *
   * `impact` is a ratio measured on curve movement with the fee excluded —
   * the fee does not grow with size, so including it would make the answer
   * mostly a constant.
   */
  depth: (mint: string, side: "buy" | "sell" = "buy", impact?: number) =>
    api.get<{
      mint: string;
      side: "buy" | "sell";
      spot: number;
      quoteSymbol: string;
      quoteUsdRate: number | null;
      max: number;
      points: DepthPoint[];
      suggestion:
        | (DepthPoint & { ceilingReached: boolean })
        | null;
    }>(
      `/api/juno/depth?mint=${mint}&token=${mint}&side=${side}${impact ? `&impact=${impact}` : ""}`,
      60_000,
    ),

  posts: (limit = 30) =>
    api.get<{ posts: Array<{ id: string; body: string; authorWallet: string; createdAt: string }> }>(
      `/api/juno/posts?limit=${limit}`,
    ),

  createPost: (input: {
    authorWallet: string;
    body: string;
    baseMint?: string | null;
    /** Set to reply. A comment is a post with a parent. */
    parentId?: string | null;
  }) => api.post<{ post: { id: string } }>("/api/juno/posts", input),

  post: (id: string) =>
    api.get<{
      post: PostDetail;
      replies: PostDetail[];
      replyCount: number;
      coin: {
        address: string;
        name: string;
        symbol: string;
        priceUsd: number;
        marketCap: number;
        currency: string;
        changePct: number | null;
        progress: number;
        graduated: boolean;
      } | null;
    }>(`/api/juno/posts/${id}`),

  /**
   * Pin a photo or video to IPFS. A video comes back with a poster frame.
   *
   * Multipart, so it bypasses the JSON helper. `file` is a web `File` in the
   * browser and the `{ uri, name, type }` shape React Native's fetch uploads
   * from on a phone.
   */
  upload: async (file: Blob | { uri: string; name: string; type: string }) => {
    const form = new FormData();
    if (file instanceof Blob) {
      form.append("file", file);
    } else {
      /*
       * Expo's fetch, which SDK 57 installs as the global on native, does not
       * take React Native's `{ uri, name, type }` file part — it throws
       * "Unsupported FormDataPart implementation" before any request is made,
       * which is how posting from the phone failed as "check your connection"
       * while every other call worked. It takes anything with `bytes()`, so
       * the picked file is read through expo-file-system and named here.
       */
      const onDisk = new DeviceFile(file.uri);
      form.append("file", {
        name: file.name,
        type: file.type,
        bytes: () => onDisk.bytes(),
      } as unknown as Blob);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120_000);
    try {
      const response = await fetch(`${API_URL}/api/juno/upload`, {
        method: "POST",
        body: form,
        signal: controller.signal,
      });
      const body = (await response.json().catch(() => null)) as
        | {
            uri: string;
            url: string;
            mimeType: string;
            posterUri?: string;
            posterUrl?: string;
            width: number | null;
            height: number | null;
            error?: string;
          }
        | null;
      if (!response.ok || !body) {
        throw new ApiError(body?.error ?? `Upload failed (${response.status})`, response.status);
      }
      return body;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (error instanceof Error && error.name === "AbortError") {
        throw new ApiError("The upload timed out. Try a shorter clip or a better connection.", 0);
      }
      throw new ApiError("Could not upload the file. Check your connection.", 0);
    } finally {
      clearTimeout(timer);
    }
  },

  /**
   * Test ETH (and Juno test USDC) for this wallet, Sepolia only.
   *
   * A 429 carries `retryAfterSeconds`, surfaced on the thrown error so the
   * card can say how long to wait.
   */
  faucet: async (wallet: string) => {
    try {
      return await api.post<{ eth: string; usdc: string | null }>(
        "/api/juno/faucet",
        { wallet, chainId: CHAIN_ID },
        90_000,
      );
    } catch (error) {
      if (error instanceof ApiError && error.status === 429) {
        const wait = (error.body as { retryAfterSeconds?: number } | null)?.retryAfterSeconds;
        throw new FaucetLimited(wait ?? null);
      }
      if (error instanceof ApiError && error.status === 503) {
        throw new ApiError("The faucet is empty right now. Try again later.", 503);
      }
      throw error;
    }
  },

  /** Pin the token's metadata, which the token points at forever. */
  pinMetadata: (input: {
    name: string;
    symbol: string;
    description?: string;
    curvePreset: string;
    format?: "post" | "reel";
    imageUrl?: string;
    mimeType?: string;
    mediaUrl?: string;
    mediaMime?: string;
    width?: number | null;
    height?: number | null;
  }) => api.post<{ uri: string }>("/api/juno/metadata", input),

  /** A quote, and the steps that trade it. Amounts are decimal strings in UI units. */
  buildSwap: (
    input: {
      curve: string;
      trader: string;
      side: "buy" | "sell";
      /** What to spend. */
      amountIn?: string;
      /** Or, on a buy, exactly how many tokens to receive. */
      amountOut?: string;
      slippageBps?: number;
    },
    /** Shorter than the default when the caller has a usable quote to fall back on. */
    timeoutMs?: number,
  ) => api.post<SwapBuild>("/api/juno/tx/swap", { chainId: CHAIN_ID, ...input }, timeoutMs),

  buildLaunch: (input: {
    creator: string;
    name: string;
    symbol: string;
    metadataUri: string;
    format: "post" | "reel";
    preset: LaunchPreset;
    /** ETH, decimal string. */
    initialBuy?: string;
  }) =>
    api.post<TxBuild<Record<string, unknown>>>("/api/juno/tx/launch", { chainId: CHAIN_ID, ...input }),

  /** Pays a coin's creator their trading fees. Only the creator's wallet can send it. */
  buildClaim: (input: { curve: string; creator: string }) =>
    api.post<TxBuild<{ amount?: number; quoteSymbol?: string; quoteUsdRate?: number | null }>>(
      "/api/juno/tx/claim",
      { chainId: CHAIN_ID, ...input },
    ),

  /** Moves a full curve into its Uniswap v3 pool. Anyone can send it. */
  buildGraduate: (input: { curve: string; caller: string }) =>
    api.post<TxBuild>("/api/juno/tx/graduate", { chainId: CHAIN_ID, ...input }),

  /** Tell the server a transaction landed. It reads the receipt itself. */
  recordTx: (input: { chainId: number; txHash: string }) =>
    api.post<TxRecord>("/api/juno/tx/record", input, 60_000),

  /**
   * ETH, USDC and, with `token`, one coin. Each is null when its read failed —
   * not zero, which would grey out a button over a network hiccup.
   */
  balances: async (wallet: string, token?: string | null): Promise<Balances> => {
    const body = await api.get<{
      eth?: number | null;
      usdc?: number | null;
      token?: number | null;
      balance?: number | null;
      tokens?: Record<string, number> | Array<{ address: string; balance: number }> | number | null;
    }>(
      `/api/juno/tx/balance?wallet=${wallet.toLowerCase()}&chainId=${CHAIN_ID}${
        token ? `&token=${token.toLowerCase()}` : ""
      }`,
    );
    let held: number | null = null;
    if (token) {
      const key = token.toLowerCase();
      const tokens = body.tokens;
      if (typeof body.token === "number") held = body.token;
      else if (typeof tokens === "number") held = tokens;
      else if (Array.isArray(tokens)) held = tokens.find((row) => row.address.toLowerCase() === key)?.balance ?? 0;
      else if (tokens && typeof tokens === "object") {
        const match = Object.entries(tokens).find(([address]) => address.toLowerCase() === key);
        held = match ? match[1] : 0;
      } else if (typeof body.balance === "number") held = body.balance;
    }
    return { eth: body.eth ?? null, usdc: body.usdc ?? null, token: held };
  },

  /**
   * A URL the native `<Image>` can actually load, or null.
   *
   * Null is not just "absent" here — it also covers media the platform cannot
   * render, and the caller is expected to draw its own glyph instead. The
   * server falls back to an identicon encoded as `data:image/svg+xml`, which
   * renders fine in a browser and makes iOS throw "URI parsing error" out of
   * RCTImageManager, taking the whole screen down with a redbox. SVG data URIs
   * are therefore filtered out here rather than at each of the four call sites.
   */
  media: (url: string | null | undefined): string | null => {
    if (!url) return null;
    if (url.startsWith("data:image/svg")) return null;
    return url.startsWith("http") ? url : `${API_URL}${url}`;
  },

  /**
   * The best *still* image for a coin, for a list row or a thumbnail.
   *
   * Reel coins carry a video in `media.url` and a real poster frame beside it.
   * Handing the video to `<Image>` renders nothing at all, which is why the
   * market list showed a grey square for every reel while the coins with no
   * media at all were fine. A still context wants the poster; only if there
   * isn't one does the video's own url get a try, and a video url that is its
   * own poster is refused rather than silently failing to draw.
   */
  still: (media: {
    kind: "image" | "video";
    url: string;
    posterUrl?: string;
  }): string | null => {
    const poster = media.posterUrl && media.posterUrl !== media.url ? media.posterUrl : null;
    if (poster) return juno.media(poster);
    return media.kind === "video" ? null : juno.media(media.url);
  },

  explorer: (kind: "tx" | "address" | "token", id: string) => explorer(kind, id),
};
