import { decodeEventLog, type Log } from "viem";

import { junoCurveAbi, junoFactoryAbi } from "@config/abi";
import { nonZero } from "./address";

/**
 * Juno's contract events, decoded into plain rows.
 *
 * Pure and shared by the indexer (`getLogs`) and `tx/record` (a receipt's
 * logs). A log counts only when it came from the right contract: `Launched`
 * from this chain's factory, the curve events from a curve Juno knows. A
 * `Trade` event emitted by any other contract is somebody else's and is
 * ignored — that is what stops `tx/record` from being a way to write fake
 * trades.
 */

export type LaunchedEvent = {
  kind: "launched";
  curve: string;
  token: string;
  creator: string;
  preset: number;
  quote: string | null;
  feed: string | null;
  bandBps: number;
  supply: bigint;
  curveSupply: bigint;
  p0: bigint;
  capFp: bigint;
  pool: string;
  metadataURI: string;
};

export type TradeEvent = {
  kind: "trade";
  curve: string;
  trader: string;
  isBuy: boolean;
  quoteAmount: bigint;
  tokenAmount: bigint;
  feeCreator: bigint;
  feeProtocol: bigint;
  priceAfter: bigint;
  soldAfter: bigint;
};

export type CreatorClaimEvent = { kind: "creatorClaim"; curve: string; creator: string; amount: bigint };

export type GraduatedEvent = {
  kind: "graduated";
  curve: string;
  pool: string;
  positionId: bigint;
  tokenLiquidity: bigint;
  quoteLiquidity: bigint;
  burned: bigint;
};

export type LpFeesEvent = { kind: "lpFees"; curve: string; tokenAmount: bigint; quoteAmount: bigint };

export type JunoEvent = LaunchedEvent | TradeEvent | CreatorClaimEvent | GraduatedEvent | LpFeesEvent;

export type Located<T> = T & { txHash: string; logIndex: number; blockNumber: number };

export const CURVE_EVENT_NAMES = ["Trade", "CreatorFeesClaimed", "Graduated", "LpFeesCollected"] as const;

type LogLike = Pick<Log, "address" | "data" | "topics" | "transactionHash" | "logIndex" | "blockNumber">;

const lower = (value: string) => value.toLowerCase();

/**
 * Decode one log, or null when it is not a Juno event from a Juno contract.
 * `curves` is the set of known curve addresses (lowercase); curves launched
 * earlier in the same batch or receipt must already be in it.
 */
export function decodeJunoLog(
  log: LogLike,
  context: { factory: string; curves: ReadonlySet<string> },
): Located<JunoEvent> | null {
  if (!log.transactionHash || log.logIndex === null || log.blockNumber === null) return null;
  const where = {
    txHash: lower(log.transactionHash),
    logIndex: Number(log.logIndex),
    blockNumber: Number(log.blockNumber),
  };
  const from = lower(log.address);
  const topics = log.topics as [`0x${string}`, ...`0x${string}`[]];

  if (from === lower(context.factory)) {
    try {
      const decoded = decodeEventLog({ abi: junoFactoryAbi, data: log.data, topics, strict: true });
      if (decoded.eventName !== "Launched") return null;
      const a = decoded.args as unknown as {
        curve: string;
        token: string;
        creator: string;
        preset: number;
        quote: string;
        feed: string;
        bandBps: number;
        supply: bigint;
        curveSupply: bigint;
        p0: bigint;
        capFp: bigint;
        pool: string;
        metadataURI: string;
      };
      return {
        ...where,
        kind: "launched",
        curve: lower(a.curve),
        token: lower(a.token),
        creator: lower(a.creator),
        preset: Number(a.preset),
        quote: nonZero(a.quote),
        feed: nonZero(a.feed),
        bandBps: Number(a.bandBps),
        supply: a.supply,
        curveSupply: a.curveSupply,
        p0: a.p0,
        capFp: a.capFp,
        pool: lower(a.pool),
        metadataURI: a.metadataURI,
      };
    } catch {
      return null;
    }
  }

  if (!context.curves.has(from)) return null;
  let decoded: { eventName: string; args: unknown };
  try {
    decoded = decodeEventLog({ abi: junoCurveAbi, data: log.data, topics, strict: true }) as typeof decoded;
  } catch {
    return null;
  }
  const args = decoded.args as Record<string, unknown>;
  switch (decoded.eventName) {
    case "Trade":
      return {
        ...where,
        kind: "trade",
        curve: from,
        trader: lower(args.trader as string),
        isBuy: Boolean(args.isBuy),
        quoteAmount: args.quoteAmount as bigint,
        tokenAmount: args.tokenAmount as bigint,
        feeCreator: args.feeCreator as bigint,
        feeProtocol: args.feeProtocol as bigint,
        priceAfter: args.priceAfter as bigint,
        soldAfter: args.soldAfter as bigint,
      };
    case "CreatorFeesClaimed":
      return { ...where, kind: "creatorClaim", curve: from, creator: lower(args.creator as string), amount: args.amount as bigint };
    case "Graduated":
      return {
        ...where,
        kind: "graduated",
        curve: from,
        pool: lower(args.pool as string),
        positionId: args.positionId as bigint,
        tokenLiquidity: args.tokenLiquidity as bigint,
        quoteLiquidity: args.quoteLiquidity as bigint,
        burned: args.burned as bigint,
      };
    case "LpFeesCollected":
      return {
        ...where,
        kind: "lpFees",
        curve: from,
        tokenAmount: args.tokenAmount as bigint,
        quoteAmount: args.quoteAmount as bigint,
      };
    default:
      return null;
  }
}

/** Decode a batch in log order, growing the curve set as `Launched` events appear. */
export function decodeJunoLogs(
  logs: LogLike[],
  context: { factory: string; curves: Iterable<string> },
): Array<Located<JunoEvent>> {
  const curves = new Set([...context.curves].map(lower));
  const ordered = [...logs].sort(
    (a, b) => Number(a.blockNumber ?? 0n) - Number(b.blockNumber ?? 0n) || Number(a.logIndex ?? 0) - Number(b.logIndex ?? 0),
  );
  const out: Array<Located<JunoEvent>> = [];
  for (const log of ordered) {
    const event = decodeJunoLog(log, { factory: context.factory, curves });
    if (!event) continue;
    if (event.kind === "launched") curves.add(event.curve);
    out.push(event);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Rows                                                                */
/* ------------------------------------------------------------------ */

export type TradeInsert = {
  txHash: string;
  logIndex: number;
  curve: string;
  token: string;
  trader: string;
  isBuy: boolean;
  quoteAmount: string;
  tokenAmount: string;
  feeCreator: string;
  feeProtocol: string;
  priceAfter: string;
  soldAfter: string;
  blockNumber: number;
  blockTime: Date;
  chainId: number;
};

export function tradeRow(event: Located<TradeEvent>, token: string, blockTime: Date, chainId: number): TradeInsert {
  return {
    txHash: event.txHash,
    logIndex: event.logIndex,
    curve: event.curve,
    token: token.toLowerCase(),
    trader: event.trader,
    isBuy: event.isBuy,
    quoteAmount: event.quoteAmount.toString(),
    tokenAmount: event.tokenAmount.toString(),
    feeCreator: event.feeCreator.toString(),
    feeProtocol: event.feeProtocol.toString(),
    priceAfter: event.priceAfter.toString(),
    soldAfter: event.soldAfter.toString(),
    blockNumber: event.blockNumber,
    blockTime,
    chainId,
  };
}

export function claimRow(
  event: Located<CreatorClaimEvent | LpFeesEvent>,
  token: string,
  blockTime: Date,
  chainId: number,
) {
  return {
    txHash: event.txHash,
    logIndex: event.logIndex,
    kind: event.kind === "creatorClaim" ? "creator" : "lp",
    curve: event.curve,
    token: token.toLowerCase(),
    account: event.kind === "creatorClaim" ? event.creator : null,
    amount: (event.kind === "creatorClaim" ? event.amount : event.quoteAmount).toString(),
    tokenAmount: event.kind === "lpFees" ? event.tokenAmount.toString() : null,
    blockNumber: event.blockNumber,
    blockTime,
    chainId,
  };
}

export function graduationRow(event: Located<GraduatedEvent>, token: string, blockTime: Date, chainId: number) {
  return {
    txHash: event.txHash,
    logIndex: event.logIndex,
    curve: event.curve,
    token: token.toLowerCase(),
    pool: event.pool,
    positionId: event.positionId.toString(),
    tokenLiquidity: event.tokenLiquidity.toString(),
    quoteLiquidity: event.quoteLiquidity.toString(),
    burned: event.burned.toString(),
    blockNumber: event.blockNumber,
    blockTime,
    chainId,
  };
}

/** The economic half of a `juno_curves` row, straight from the event. */
export function curveRowFromLaunch(
  event: Located<LaunchedEvent>,
  context: { chainId: number; blockTime: Date; refSymbol: string | null; quoteSymbol: string; quoteDecimals: number },
) {
  return {
    token: event.token,
    curve: event.curve,
    creator: event.creator,
    quote: event.quote,
    quoteSymbol: context.quoteSymbol,
    quoteDecimals: context.quoteDecimals,
    preset: event.preset,
    feed: event.feed,
    refSymbol: context.refSymbol,
    bandBps: event.bandBps,
    supply: event.supply.toString(),
    curveSupply: event.curveSupply.toString(),
    p0: event.p0.toString(),
    capFp: event.capFp.toString(),
    pool: event.pool,
    chainId: context.chainId,
    txHash: event.txHash,
    blockNumber: event.blockNumber,
    metadataUri: event.metadataURI,
    createdAt: context.blockTime,
  };
}
