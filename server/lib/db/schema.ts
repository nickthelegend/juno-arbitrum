import {
  bigint,
  boolean,
  doublePrecision,
  index,
  integer,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";

/* ==================================================================
   Juno on Arbitrum.
   ==================================================================
   The contracts are the source of truth for every number that moves.
   These tables hold two kinds of thing:

   - what the chain said, written down by the indexer from event logs
     (curves, trades, claims, graduations), keyed by the log that proves
     it, so any row can be checked on Arbiscan; and
   - what people wrote that has nowhere else to live (posts, follows,
     watchlists, plans).

   Addresses are lowercase 0x-prefixed, 42 characters. Token and quote
   amounts are integers in base units, stored as `numeric` so nothing is
   lost to floating point; the server converts them for display.
   ================================================================== */

/** 0x + 40 hex characters. */
const address = (name: string) => varchar(name, { length: 42 });
/** 0x + 64 hex characters. */
const hash = (name: string) => varchar(name, { length: 66 });
/** A uint256 in base units. */
const uint = (name: string) => numeric(name, { precision: 78, scale: 0 });

export const junoCoinFormatEnum = pgEnum("juno_coin_format", ["post", "reel"]);

export const junoPlanCadenceEnum = pgEnum("juno_plan_cadence", ["daily", "weekly", "monthly"]);

/**
 * One row per `Launched` event: a token and the curve that sells it.
 *
 * Every economic column is copied from the event. Name and symbol are read
 * from the token contract; format and media come from the metadata JSON the
 * token's `metadataURI` points at, which is why they can be null for a moment
 * after a launch and are filled in by the next index pass.
 */
export const junoCurves = pgTable(
  "juno_curves",
  {
    /** The ERC-20. Canonical id everywhere in the app and in URLs. */
    token: address("token").primaryKey(),
    curve: address("curve").notNull(),
    creator: address("creator").notNull(),
    /** Null for native ETH. */
    quote: address("quote"),
    quoteSymbol: varchar("quote_symbol", { length: 8 }).notNull(),
    quoteDecimals: smallint("quote_decimals").notNull(),
    /** Factory preset id: 0 content, 1 thin-name, 2 ipo-book, 3 tight-nav. */
    preset: smallint("preset").notNull(),
    /** Chainlink feed, trackers only. */
    feed: address("feed"),
    /** TSLA, NVDA, AAPL — resolved from `config/addresses.ts` feeds. */
    refSymbol: varchar("ref_symbol", { length: 16 }),
    bandBps: integer("band_bps").notNull().default(0),
    supply: uint("supply").notNull(),
    curveSupply: uint("curve_supply").notNull(),
    p0: uint("p0").notNull(),
    capFp: uint("cap_fp").notNull(),
    /** The Uniswap v3 pool, created at launch and seeded at graduation. */
    pool: address("pool").notNull(),
    chainId: integer("chain_id").notNull(),
    txHash: hash("tx_hash").notNull(),
    blockNumber: bigint("block_number", { mode: "number" }).notNull(),
    format: junoCoinFormatEnum("format").notNull().default("post"),
    /**
     * Whether the coin appears in public lists. Unlisting hides a rehearsal
     * from browsing and nothing else: its page, holders and index still work.
     */
    listed: boolean("listed").notNull().default(true),
    name: text("name").notNull(),
    symbol: varchar("symbol", { length: 32 }).notNull(),
    metadataUri: text("metadata_uri").notNull(),
    description: text("description"),
    mediaUrl: text("media_url"),
    posterUrl: text("poster_url"),
    /** Image or video is decided by this, never by the URL (IPFS has no extension). */
    mediaMime: text("media_mime"),
    mediaWidth: integer("media_width"),
    mediaHeight: integer("media_height"),
    /** False until the metadata JSON was fetched; the indexer retries. */
    metadataFetched: boolean("metadata_fetched").notNull().default(false),
    /** The launch block's time. */
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("juno_curves_curve_idx").on(table.curve),
    index("juno_curves_chain_created_idx").on(table.chainId, table.createdAt),
    index("juno_curves_creator_idx").on(table.chainId, table.creator),
    index("juno_curves_ref_idx").on(table.chainId, table.refSymbol),
  ],
);

/** One row per `Trade` event. */
export const junoTrades = pgTable(
  "juno_trades",
  {
    txHash: hash("tx_hash").notNull(),
    logIndex: integer("log_index").notNull(),
    curve: address("curve").notNull(),
    token: address("token").notNull(),
    trader: address("trader").notNull(),
    isBuy: boolean("is_buy").notNull(),
    /** Buy: what the trader paid, fee included. Sell: what they received, fee removed. */
    quoteAmount: uint("quote_amount").notNull(),
    tokenAmount: uint("token_amount").notNull(),
    feeCreator: uint("fee_creator").notNull(),
    feeProtocol: uint("fee_protocol").notNull(),
    /** Curve price after the trade, quote base units per whole token. */
    priceAfter: uint("price_after").notNull(),
    soldAfter: uint("sold_after").notNull(),
    blockNumber: bigint("block_number", { mode: "number" }).notNull(),
    blockTime: timestamp("block_time", { withTimezone: true }).notNull(),
    chainId: integer("chain_id").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.txHash, table.logIndex] }),
    index("juno_trades_curve_time_idx").on(table.curve, table.blockTime),
    index("juno_trades_trader_idx").on(table.chainId, table.trader),
    index("juno_trades_chain_time_idx").on(table.chainId, table.blockTime),
  ],
);

/**
 * Fees paid out: `CreatorFeesClaimed` (kind `creator`) and
 * `LpFeesCollected` (kind `lp`, split creator/protocol by the contract).
 */
export const junoClaims = pgTable(
  "juno_claims",
  {
    txHash: hash("tx_hash").notNull(),
    logIndex: integer("log_index").notNull(),
    kind: varchar("kind", { length: 8 }).notNull(),
    curve: address("curve").notNull(),
    token: address("token").notNull(),
    /** The creator, for a creator claim. Null for LP fee collection. */
    account: address("account"),
    /** Quote paid out, in base units. */
    amount: uint("amount").notNull(),
    /** Tokens paid out (LP fees only). */
    tokenAmount: uint("token_amount"),
    blockNumber: bigint("block_number", { mode: "number" }).notNull(),
    blockTime: timestamp("block_time", { withTimezone: true }).notNull(),
    chainId: integer("chain_id").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.txHash, table.logIndex] }),
    index("juno_claims_curve_idx").on(table.curve),
  ],
);

/** One row per `Graduated` event. */
export const junoGraduations = pgTable(
  "juno_graduations",
  {
    txHash: hash("tx_hash").notNull(),
    logIndex: integer("log_index").notNull(),
    curve: address("curve").notNull(),
    token: address("token").notNull(),
    pool: address("pool").notNull(),
    positionId: uint("position_id").notNull(),
    tokenLiquidity: uint("token_liquidity").notNull(),
    quoteLiquidity: uint("quote_liquidity").notNull(),
    burned: uint("burned").notNull(),
    blockNumber: bigint("block_number", { mode: "number" }).notNull(),
    blockTime: timestamp("block_time", { withTimezone: true }).notNull(),
    chainId: integer("chain_id").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.txHash, table.logIndex] }),
    uniqueIndex("juno_graduations_curve_idx").on(table.curve),
  ],
);

/** How far the indexer has read, per chain. */
export const junoIndexCursor = pgTable("juno_index_cursor", {
  chainId: integer("chain_id").primaryKey(),
  lastBlock: bigint("last_block", { mode: "number" }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Creator posts — the non-trade half of the social feed. A post may name the
 * coin it is about, or stand alone; a reply is a post with a parent.
 */
export const junoPosts = pgTable(
  "juno_posts",
  {
    id: varchar("id", { length: 32 }).primaryKey(),
    authorWallet: address("author_wallet").notNull(),
    chainId: integer("chain_id").notNull(),
    body: text("body").notNull(),
    /** Optional: the token this post is about. */
    token: address("token"),
    mediaUrl: text("media_url"),
    mediaMime: text("media_mime"),
    parentId: varchar("parent_id", { length: 32 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("juno_posts_chain_created_idx").on(table.chainId, table.createdAt),
    index("juno_posts_author_idx").on(table.authorWallet),
    index("juno_posts_token_idx").on(table.token),
    index("juno_posts_parent_idx").on(table.parentId),
  ],
);

/** Who follows whom. The pair is the key, so following twice is a no-op. */
export const junoFollows = pgTable(
  "juno_follows",
  {
    followerWallet: address("follower_wallet").notNull(),
    targetWallet: address("target_wallet").notNull(),
    chainId: integer("chain_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.followerWallet, table.targetWallet, table.chainId] }),
    index("juno_follows_target_idx").on(table.chainId, table.targetWallet),
    index("juno_follows_follower_idx").on(table.chainId, table.followerWallet),
  ],
);

/** Coins a wallet is watching, with an optional price alert. */
export const junoWatchlist = pgTable(
  "juno_watchlist",
  {
    wallet: address("wallet").notNull(),
    token: address("token").notNull(),
    chainId: integer("chain_id").notNull(),
    /** Alert when the price crosses this, in the coin's display currency. */
    alertPrice: doublePrecision("alert_price"),
    /** The price when the alert was set, so the crossing direction is knowable. */
    alertSetAtPrice: doublePrecision("alert_set_at_price"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.wallet, table.token, table.chainId] }),
    index("juno_watchlist_wallet_idx").on(table.chainId, table.wallet),
    index("juno_watchlist_token_idx").on(table.chainId, table.token),
  ],
);

/**
 * A recurring buy someone committed to. Stores the intent; each buy is the
 * same server-built, device-signed transaction as any other, and
 * `contributed` moves only after one confirms.
 */
export const junoPlans = pgTable(
  "juno_plans",
  {
    id: varchar("id", { length: 32 }).primaryKey(),
    wallet: address("wallet").notNull(),
    token: address("token").notNull(),
    chainId: integer("chain_id").notNull(),
    /** Quote-token amount per contribution. */
    amount: doublePrecision("amount").notNull(),
    cadence: junoPlanCadenceEnum("cadence").notNull(),
    target: doublePrecision("target"),
    contributed: doublePrecision("contributed").notNull().default(0),
    fills: integer("fills").notNull().default(0),
    lastFilledAt: timestamp("last_filled_at", { withTimezone: true }),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("juno_plans_wallet_idx").on(table.chainId, table.wallet),
    index("juno_plans_token_idx").on(table.chainId, table.token),
  ],
);
