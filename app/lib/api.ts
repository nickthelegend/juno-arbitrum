import Constants from "expo-constants";
import { File as DeviceFile } from "expo-file-system";

/**
 * The Juno API client.
 *
 * Every read and every transaction comes from the Next.js app. The phone never
 * builds a Solana transaction — it asks for bytes, signs them with the embedded
 * wallet, and posts them back. See `lib/juno/tx.ts` on the server for why.
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
  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
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
      throw new ApiError(message, response.status);
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

export const WSOL_MINT = "So11111111111111111111111111111111111111112";
/** Circle's devnet USDC — the quote token of Juno's USDC-priced pools. */
export const USDC_DEVNET = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

export type CurveState = {
  progress: number;
  raisedUsd: number;
  thresholdUsd: number;
  graduated: boolean;
};

export type NavReference = {
  feed: string;
  priceUsd: number;
  /** Null when the curve and the reference cannot be compared — see `unitsPerToken`. */
  deviation: number | null;
  updatedAt: string;
  bandBps: number;
  withinBand: boolean | null;
  /** The curve's price restated in the reference's units. Null without a ratio. */
  impliedUsd: number | null;
  /** How much of the reference one token stands for, fixed at launch. */
  unitsPerToken: number | null;
  /** `"mark"` is a published price with no timestamp — freshness is unknown. */
  state: "live" | "closed" | "stale" | "mark";
  /** Null when the source publishes no timestamp, as Tessera does not. */
  ageSeconds: number | null;
  source: "pyth" | "tessera";
  /** Present only on a Tessera reference: a company, not a ticker. */
  tessera: {
    id: string;
    mint: string;
    sector: string;
    holders: number;
    markValuation: number;
    supply: number | null;
    /** Why this token cannot be a Juno quote mint, read from the mint itself. */
    blocked: string | null;
  } | null;
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
  pool: string;
  config: string;
  quote: { mint: string; symbol: string; decimals: number };
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
  /**
   * What the market is marked against, from the registry. Null for a post or
   * reel; undefined from a server that predates the field.
   */
  reference?: { source: "pyth" | "tessera"; id: string } | null;
  /** Present when the list was asked for `social=1`. */
  likes?: number;
  commentCount?: number;
  viewerLiked?: boolean | null;
};

/** A pre-IPO company as Tessera publishes it, with the Juno markets marked against it. */
export type TesseraCompany = {
  id: string;
  name: string;
  sector: string;
  mint: string;
  markPrice: number;
  holders: number;
  markValuation: number;
  supply: number | null;
  floatUsd: number | null;
  shareOfCompany: number | null;
  onChain: { transferFeeBps: number | null; blocked: string | null } | null;
  markets: Array<{
    address: string;
    name: string;
    symbol: string;
    /** Null when the curve could not be read just now; the market still exists. */
    priceUsd: number | null;
    marketCap: number | null;
    currency: string | null;
    curvePreset: string;
    progress: number | null;
    graduated: boolean | null;
    deviation: number | null;
    withinBand: boolean | null;
  }>;
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
  signature?: string;
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
      signature?: string;
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

/** A comment on a coin. `side` and `signature` are set when it came with a trade. */
export type CoinComment = {
  id: string;
  coinMint: string;
  wallet: string;
  body: string;
  side?: "buy" | "sell";
  signature?: string;
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

export type UnsignedTransaction = { transaction: string; label: string; bytes: number };
export type BlockhashWindow = { blockhash: string; lastValidBlockHeight: number };

export type SwapBuild = {
  unsigned: UnsignedTransaction;
  window: BlockhashWindow;
  quote: {
    amountOut: number;
    minimumAmountOut: number;
    fee: number;
    priceImpact: number;
    /** Exact-out buys only: expected cost, and the most the transaction may spend. */
    amountIn?: number;
    maximumAmountIn?: number;
  };
  quoteSymbol: string;
  quoteUsdRate: number | null;
  pool: string;
  symbol: string;
};

export type LaunchBuild = {
  steps: UnsignedTransaction[];
  window: BlockhashWindow;
  config: string;
  baseMint: string;
  pool: string;
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
   * `amount`, `target` and `contributed` are **quote-token units** — SOL or
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
      cluster: string;
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
      cluster: string;
      items: FeedItem[];
      /** The trade half was walked against a refusing endpoint — not the whole cluster. */
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
      /** Each tracker's reference price — a Pyth or Tessera read per tracker. */
      nav?: boolean;
    },
  ) =>
    api.get<{
      cluster: string;
      coins: Coin[];
      /** Registry rows the server could not price — the list is short by this many. */
      missing: number;
    }>(
      `/api/juno/coins?limit=40${sort ? `&sort=${sort}` : ""}${
        extra?.social ? `&social=1${extra.viewer ? `&viewer=${extra.viewer}` : ""}` : ""
      }${extra?.nav ? "&nav=1" : ""}`,
    ),

  /** Pre-IPO companies from Tessera, each with the Juno markets marked against it. */
  tessera: () =>
    api.get<{ cluster: string; tokens: TesseraCompany[] }>("/api/juno/tessera"),

  /** Like counts for a page of coins, and whether `viewer` liked each. */
  likes: (coins: string[], viewer?: string | null) =>
    api.get<{ counts: Record<string, { likes: number; comments: number; viewerLiked: boolean | null }> }>(
      `/api/juno/likes?coins=${coins.join(",")}${viewer ? `&viewer=${viewer}` : ""}`,
    ),

  setLike: (input: { coin: string; wallet: string; like: boolean }) =>
    api.post<{ coin: string; likes: number; liked: boolean }>("/api/juno/likes", input),

  coin: (mint: string) =>
    api.get<{
      cluster: string;
      coin: Coin;
      activity: Activity[];
      /** The swap walk was cut short — an empty `activity` is not "no trades". */
      activityPartial: boolean;
      holders: Holder[];
      /** The holder read was refused — an empty `holders` is not "no holders". */
      holdersUnreadable: boolean;
      /** Null when the swap history could not be read at all — not "nobody traded". */
      crowd: Crowd | null;
      launchSignature: string;
    }>(`/api/juno/coins/${mint}`),

  portfolio: (wallet: string) => api.get<Portfolio>(`/api/juno/portfolio/${wallet}`),

  /** Comments on a coin, newest first. */
  comments: (mint: string) =>
    api.get<{ comments: CoinComment[] }>(`/api/juno/comments?coin=${mint}`),

  /**
   * Say something about a coin — optionally alongside a trade you just made.
   *
   * `side` and `signature` are what turn a comment into an announcement: the
   * row then carries which way you went and the transaction that proves it,
   * so the claim is checkable rather than asserted.
   */
  addComment: (input: {
    coin: string;
    wallet: string;
    body: string;
    side?: "buy" | "sell";
    signature?: string;
  }) => api.post<{ comment: CoinComment }>("/api/juno/comments", input),

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
      `/api/juno/depth?mint=${mint}&side=${side}${impact ? `&impact=${impact}` : ""}`,
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
   * Index a launch after its pool transaction has confirmed.
   *
   * The server re-reads the pool from chain before writing the row, so this
   * cannot be used to claim a pool that does not exist.
   */
  recordLaunch: (input: {
    baseMint: string;
    poolAddress: string;
    configAddress: string;
    quoteMint: string;
    creatorWallet: string;
    name: string;
    symbol: string;
    format: "post" | "reel";
    curvePreset: string;
    createSignature: string;
    description?: string | null;
    mediaUrl?: string | null;
    posterUrl?: string | null;
    mediaMime?: string | null;
    mediaWidth?: number | null;
    mediaHeight?: number | null;
  }) => api.post<{ pool: unknown }>("/api/juno/pools", input),

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

  /** Devnet SOL for this wallet, from the public faucet or the operator's. */
  faucet: (wallet: string) =>
    api.post<{ signature: string; amount: number; source: string }>("/api/juno/faucet", { wallet }, 90_000),

  /** Pin the token's metadata, which the mint points at forever. */
  pinMetadata: (input: {
    name: string;
    symbol: string;
    description?: string;
    curvePreset: string;
    imageUrl?: string;
    mimeType?: string;
  }) => api.post<{ uri: string }>("/api/juno/metadata", input),

  buildSwap: (
    input: {
      mint: string;
      owner: string;
      side: "buy" | "sell";
      /** What to spend. */
      amountIn?: number;
      /** Or, on a buy, exactly how many tokens to receive (`SwapMode.ExactOut`). */
      amountOut?: number;
      slippageBps?: number;
    },
    /** Shorter than the default when the caller has a usable quote to fall back on. */
    timeoutMs?: number,
  ) => api.post<SwapBuild>("/api/juno/tx/swap", input, timeoutMs),

  buildLaunch: (input: {
    creator: string;
    name: string;
    symbol: string;
    preset: string;
    uri?: string;
    quoteMint?: string;
  }) => api.post<LaunchBuild>("/api/juno/tx/launch", input),

  /**
   * What this wallet can spend of one token. `null` when the read failed —
   * not zero, which would grey out a button over a network hiccup.
   */
  balance: (wallet: string, mint: string) =>
    api.get<{ wallet: string; mint: string; balance: number | null }>(
      `/api/juno/tx/balance?wallet=${wallet}&mint=${mint}`,
    ),

  /** The unsigned transaction that pays a coin's creator their trading fees. */
  buildClaim: (input: { mint: string; owner: string }) =>
    api.post<{
      unsigned: UnsignedTransaction;
      window: BlockhashWindow;
      amount: number;
      quoteSymbol: string;
      quoteUsdRate: number | null;
      pool: string;
    }>("/api/juno/tx/claim", input),

  submit: (input: { transaction: string; window?: BlockhashWindow; poolAddress?: string }) =>
    // Submitting waits for confirmation, which is slower than a read.
    api.post<{ signature: string }>("/api/juno/tx/submit", input, 90_000),

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

  explorer: (kind: "tx" | "account" | "token", id: string, cluster = "devnet") =>
    `https://solscan.io/${kind}/${id}${cluster === "devnet" ? "?cluster=devnet" : ""}`,
};
