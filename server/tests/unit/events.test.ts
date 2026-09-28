import { describe, expect, it } from "vitest";
import { encodeAbiParameters, encodeEventTopics, getAbiItem, zeroAddress, type Abi } from "viem";

import { junoCurveAbi, junoFactoryAbi } from "@config/abi";
import {
  claimRow,
  curveRowFromLaunch,
  decodeJunoLog,
  decodeJunoLogs,
  graduationRow,
  tradeRow,
  type Located,
  type TradeEvent,
} from "@/lib/juno/events";

/**
 * Contract events → database rows.
 *
 * The logs here are encoded with the real ABIs from `config/abi.ts`, exactly
 * as a node would return them, so a change in the contracts' event shapes
 * breaks these tests rather than the indexer in production.
 */

const FACTORY = "0x00000000000000000000000000000000000fac70";
const CURVE = "0xc0ffee0000000000000000000000000000000001";
const TOKEN = "0x70ce000000000000000000000000000000000002";
const CREATOR = "0xabcdef0000000000000000000000000000000003";
const TRADER = "0x1111111111111111111111111111111111111111";
const POOL = "0x5555555555555555555555555555555555555555";
const FEED = "0x3609baAa0a9b1f0FE4d6CC01884585d0e191C3E3";
const TX = `0x${"ab".repeat(32)}` as const;

let logIndex = 0;

/** A log as `eth_getLogs` returns it. */
function makeLog(abi: Abi, eventName: string, args: Record<string, unknown>, address: string, blockNumber = 100n) {
  const event = getAbiItem({ abi, name: eventName }) as unknown as { inputs: Array<{ name: string; type: string; indexed?: boolean }> };
  const topics = encodeEventTopics({ abi, eventName, args } as never) as `0x${string}`[];
  const data = encodeAbiParameters(
    event.inputs.filter((input) => !input.indexed),
    event.inputs.filter((input) => !input.indexed).map((input) => args[input.name]),
  );
  return {
    address: address as `0x${string}`,
    topics: topics as [`0x${string}`, ...`0x${string}`[]],
    data,
    transactionHash: TX,
    logIndex: logIndex++,
    blockNumber,
  };
}

const launched = (over: Record<string, unknown> = {}) =>
  makeLog(
    junoFactoryAbi as Abi,
    "Launched",
    {
      curve: CURVE,
      token: TOKEN,
      creator: CREATOR,
      preset: 0,
      quote: zeroAddress,
      feed: zeroAddress,
      bandBps: 0,
      supply: 10n ** 27n,
      curveSupply: 8n * 10n ** 26n,
      p0: 20_000_000n,
      capFp: 25n * 10n ** 18n,
      pool: POOL,
      metadataURI: "ipfs://bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy",
      ...over,
    },
    FACTORY,
  );

const trade = (address = CURVE, over: Record<string, unknown> = {}) =>
  makeLog(
    junoCurveAbi as Abi,
    "Trade",
    {
      trader: TRADER,
      isBuy: true,
      quoteAmount: 10n ** 16n,
      tokenAmount: 123n * 10n ** 18n,
      feeCreator: 45n * 10n ** 12n,
      feeProtocol: 45n * 10n ** 12n,
      priceAfter: 21_000_000n,
      soldAfter: 123n * 10n ** 18n,
      ...over,
    },
    address,
  );

const context = { factory: FACTORY, curves: new Set([CURVE.toLowerCase()]) };

describe("decodeJunoLog", () => {
  it("decodes Launched from the factory, lowercased, with zero addresses as null", () => {
    const event = decodeJunoLog(launched(), context);
    expect(event).toMatchObject({
      kind: "launched",
      curve: CURVE.toLowerCase(),
      token: TOKEN.toLowerCase(),
      creator: CREATOR.toLowerCase(),
      quote: null,
      feed: null,
      preset: 0,
      p0: 20_000_000n,
      capFp: 25n * 10n ** 18n,
      pool: POOL.toLowerCase(),
      txHash: TX,
      blockNumber: 100,
    });
  });

  it("keeps a tracker's feed and band", () => {
    const event = decodeJunoLog(launched({ preset: 3, feed: FEED, bandBps: 200, quote: TRADER }), context);
    expect(event).toMatchObject({ kind: "launched", preset: 3, feed: FEED.toLowerCase(), bandBps: 200, quote: TRADER });
  });

  it("ignores a Launched event from any other contract", () => {
    const fake = { ...launched(), address: TRADER as `0x${string}` };
    expect(decodeJunoLog(fake, context)).toBeNull();
  });

  it("decodes a Trade from a known curve", () => {
    const event = decodeJunoLog(trade(), context);
    expect(event).toMatchObject({
      kind: "trade",
      curve: CURVE.toLowerCase(),
      trader: TRADER,
      isBuy: true,
      quoteAmount: 10n ** 16n,
      tokenAmount: 123n * 10n ** 18n,
      priceAfter: 21_000_000n,
    });
  });

  it("refuses a Trade emitted by a contract Juno does not know", () => {
    expect(decodeJunoLog(trade("0x9999999999999999999999999999999999999999"), context)).toBeNull();
  });

  it("decodes claims, LP fees and graduation", () => {
    const claim = decodeJunoLog(
      makeLog(junoCurveAbi as Abi, "CreatorFeesClaimed", { creator: CREATOR, amount: 5n }, CURVE),
      context,
    );
    expect(claim).toMatchObject({ kind: "creatorClaim", creator: CREATOR.toLowerCase(), amount: 5n });

    const lp = decodeJunoLog(
      makeLog(junoCurveAbi as Abi, "LpFeesCollected", { tokenAmount: 7n, quoteAmount: 9n }, CURVE),
      context,
    );
    expect(lp).toMatchObject({ kind: "lpFees", tokenAmount: 7n, quoteAmount: 9n });

    const graduated = decodeJunoLog(
      makeLog(
        junoCurveAbi as Abi,
        "Graduated",
        { pool: POOL, positionId: 42n, tokenLiquidity: 1n, quoteLiquidity: 2n, burned: 3n },
        CURVE,
      ),
      context,
    );
    expect(graduated).toMatchObject({ kind: "graduated", pool: POOL.toLowerCase(), positionId: 42n, burned: 3n });
  });

  it("returns null for a pending log with no hash", () => {
    expect(decodeJunoLog({ ...trade(), transactionHash: null } as never, context)).toBeNull();
  });
});

describe("decodeJunoLogs", () => {
  it("reads a new curve's trades in the same batch as its launch, in log order", () => {
    const other = "0xc0ffee0000000000000000000000000000000009";
    const launch = launched({ curve: other });
    const first = trade(other);
    // Returned out of order on purpose: the batch is sorted by block and index.
    const events = decodeJunoLogs([first, launch].map((log, i) => ({ ...log, logIndex: i === 0 ? 5 : 1 })), {
      factory: FACTORY,
      curves: [],
    });
    expect(events.map((event) => event.kind)).toEqual(["launched", "trade"]);
  });
});

describe("rows", () => {
  it("turns a trade into a juno_trades row with integer strings", () => {
    const event = decodeJunoLog(trade(), context) as Located<TradeEvent>;
    const at = new Date("2026-09-28T12:00:00Z");
    expect(tradeRow(event, TOKEN, at, 421614)).toEqual({
      txHash: TX,
      logIndex: event.logIndex,
      curve: CURVE.toLowerCase(),
      token: TOKEN.toLowerCase(),
      trader: TRADER,
      isBuy: true,
      quoteAmount: "10000000000000000",
      tokenAmount: "123000000000000000000",
      feeCreator: "45000000000000",
      feeProtocol: "45000000000000",
      priceAfter: "21000000",
      soldAfter: "123000000000000000000",
      blockNumber: 100,
      blockTime: at,
      chainId: 421614,
    });
  });

  it("maps a launch onto the economic columns of juno_curves", () => {
    const event = decodeJunoLog(launched({ preset: 3, feed: FEED, bandBps: 200 }), context);
    if (event?.kind !== "launched") throw new Error("expected a launch");
    const row = curveRowFromLaunch(event, {
      chainId: 42161,
      blockTime: new Date(0),
      refSymbol: "TSLA",
      quoteSymbol: "USDC",
      quoteDecimals: 6,
    });
    expect(row).toMatchObject({
      token: TOKEN.toLowerCase(),
      curve: CURVE.toLowerCase(),
      preset: 3,
      feed: FEED.toLowerCase(),
      refSymbol: "TSLA",
      bandBps: 200,
      supply: "1000000000000000000000000000",
      curveSupply: "800000000000000000000000000",
      p0: "20000000",
      capFp: "25000000000000000000",
      chainId: 42161,
      quoteSymbol: "USDC",
      quoteDecimals: 6,
    });
  });

  it("files creator claims and LP fees under their kinds", () => {
    const at = new Date(0);
    const claim = decodeJunoLog(makeLog(junoCurveAbi as Abi, "CreatorFeesClaimed", { creator: CREATOR, amount: 5n }, CURVE), context);
    const lp = decodeJunoLog(makeLog(junoCurveAbi as Abi, "LpFeesCollected", { tokenAmount: 7n, quoteAmount: 9n }, CURVE), context);
    if (claim?.kind !== "creatorClaim" || lp?.kind !== "lpFees") throw new Error("expected claims");
    expect(claimRow(claim, TOKEN, at, 1)).toMatchObject({ kind: "creator", account: CREATOR.toLowerCase(), amount: "5", tokenAmount: null });
    expect(claimRow(lp, TOKEN, at, 1)).toMatchObject({ kind: "lp", account: null, amount: "9", tokenAmount: "7" });

    const graduated = decodeJunoLog(
      makeLog(junoCurveAbi as Abi, "Graduated", { pool: POOL, positionId: 42n, tokenLiquidity: 1n, quoteLiquidity: 2n, burned: 3n }, CURVE),
      context,
    );
    if (graduated?.kind !== "graduated") throw new Error("expected graduation");
    expect(graduationRow(graduated, TOKEN, at, 1)).toMatchObject({ pool: POOL.toLowerCase(), positionId: "42", burned: "3" });
  });
});
