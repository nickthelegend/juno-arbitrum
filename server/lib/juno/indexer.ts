import "server-only";

import { eq, sql } from "drizzle-orm";
import { erc20Abi, getAbiItem, type Log } from "viem";

import { junoCurveAbi, junoFactoryAbi } from "@config/abi";
import { getDb } from "@/lib/db";
import { junoClaims, junoCurves, junoGraduations, junoIndexCursor, junoTrades } from "@/lib/db/schema";
import {
  factoryBlock,
  publicClient,
  refSymbolForFeed,
  requireDeployment,
  type ChainId,
} from "./chains";
import {
  CURVE_EVENT_NAMES,
  claimRow,
  curveRowFromLaunch,
  decodeJunoLogs,
  graduationRow,
  tradeRow,
  type JunoEvent,
  type LaunchedEvent,
  type Located,
} from "./events";
import { fetchMetadata, parseMetadata } from "./metadata";
import { invalidateCurve } from "./onchain";
import { knownCurves, type CurveRow } from "./registry";
import { withRetry } from "./rpc";

/**
 * The event poller: `getLogs` from the factory and every known curve, written
 * to Postgres.
 *
 * - Batches of at most 5,000 blocks (Arbitrum's public RPC caps ranges); a
 *   batch the endpoint refuses as too large is halved and retried.
 * - Every write is an idempotent upsert keyed by (tx hash, log index), so a
 *   batch can be read twice without harm.
 * - Reorg safety: each run re-reads the last 20 blocks before the cursor.
 * - One run per chain at a time in this process.
 */

const REORG_DEPTH = 20;
const MAX_BATCH = 5_000;
const MIN_BATCH = 250;
const ADDRESS_CHUNK = 250;

const launchedEvent = getAbiItem({ abi: junoFactoryAbi, name: "Launched" });
const curveEvents = CURVE_EVENT_NAMES.map((name) => getAbiItem({ abi: junoCurveAbi, name }));

export type IndexReport = {
  chainId: ChainId;
  from: number | null;
  to: number | null;
  latest: number;
  lag: number;
  batches: number;
  launched: number;
  trades: number;
  claims: number;
  graduations: number;
  metadataRefreshed: number;
  /** Rows actually written this run (the counts above include re-scanned events). */
  newRows: number;
  done: boolean;
};

/* ------------------------------------------------------------------ */
/* Block times                                                         */
/* ------------------------------------------------------------------ */

const blockTimes = new Map<string, Date>();

export async function blockTime(chainId: ChainId, blockNumber: number): Promise<Date> {
  const key = `${chainId}:${blockNumber}`;
  const hit = blockTimes.get(key);
  if (hit) return hit;
  const block = await withRetry(() => publicClient(chainId).getBlock({ blockNumber: BigInt(blockNumber) }));
  const at = new Date(Number(block.timestamp) * 1000);
  if (blockTimes.size > 20_000) blockTimes.clear();
  blockTimes.set(key, at);
  return at;
}

/* ------------------------------------------------------------------ */
/* Writing                                                             */
/* ------------------------------------------------------------------ */

async function quoteInfo(chainId: ChainId, quote: string | null): Promise<{ symbol: string; decimals: number }> {
  if (!quote) return { symbol: "ETH", decimals: 18 };
  const client = publicClient(chainId);
  const [symbol, decimals] = await Promise.all([
    client.readContract({ address: quote as `0x${string}`, abi: erc20Abi, functionName: "symbol" }).catch(() => "USDC"),
    client.readContract({ address: quote as `0x${string}`, abi: erc20Abi, functionName: "decimals" }).catch(() => 6),
  ]);
  return { symbol: /usdc/i.test(symbol) ? "USDC" : symbol.slice(0, 8), decimals: Number(decimals) };
}

async function tokenIdentity(chainId: ChainId, token: string): Promise<{ name: string; symbol: string }> {
  const client = publicClient(chainId);
  const address = token as `0x${string}`;
  const [name, symbol] = await Promise.all([
    withRetry(() => client.readContract({ address, abi: erc20Abi, functionName: "name" })),
    withRetry(() => client.readContract({ address, abi: erc20Abi, functionName: "symbol" })),
  ]);
  return { name, symbol: symbol.slice(0, 32) };
}

/** Insert a curve from its `Launched` event. Name/symbol from the token; media from its metadata. True when new. */
export async function recordLaunch(chainId: ChainId, event: Located<LaunchedEvent>): Promise<boolean> {
  const db = getDb();
  const existing = await db.select({ token: junoCurves.token }).from(junoCurves).where(eq(junoCurves.token, event.token)).limit(1);
  if (existing.length > 0) return false;

  const [at, quote, identity, rawMetadata] = await Promise.all([
    blockTime(chainId, event.blockNumber),
    quoteInfo(chainId, event.quote),
    tokenIdentity(chainId, event.token),
    fetchMetadata(event.metadataURI).catch(() => null),
  ]);
  const metadata = rawMetadata ? parseMetadata(rawMetadata) : null;

  const inserted = await db
    .insert(junoCurves)
    .values({
      ...curveRowFromLaunch(event, {
        chainId,
        blockTime: at,
        refSymbol: refSymbolForFeed(chainId, event.feed),
        quoteSymbol: quote.symbol,
        quoteDecimals: quote.decimals,
      }),
      name: identity.name,
      symbol: identity.symbol,
      format: metadata?.format ?? "post",
      description: metadata?.description ?? null,
      mediaUrl: metadata?.mediaUrl ?? null,
      posterUrl: metadata?.posterUrl ?? null,
      mediaMime: metadata?.mediaMime ?? null,
      mediaWidth: metadata?.mediaWidth ?? null,
      mediaHeight: metadata?.mediaHeight ?? null,
      metadataFetched: rawMetadata !== null,
    })
    .onConflictDoNothing()
    .returning({ token: junoCurves.token });
  return inserted.length > 0;
}

/**
 * Write decoded curve events. `curves` maps curve → row (for the token
 * address); curves launched in the same batch must be recorded first.
 */
export async function recordCurveEvents(
  chainId: ChainId,
  events: Array<Located<JunoEvent>>,
  curves: Map<string, Pick<CurveRow, "token">>,
): Promise<{ trades: number; claims: number; graduations: number; inserted: number }> {
  const db = getDb();
  const counts = { trades: 0, claims: 0, graduations: 0, inserted: 0 };
  const written = (rows: unknown[]) => {
    counts.inserted += rows.length;
  };
  const touched = new Set<string>();

  for (const event of events) {
    if (event.kind === "launched") continue;
    const row = curves.get(event.curve);
    if (!row) continue;
    const at = await blockTime(chainId, event.blockNumber);
    touched.add(event.curve);

    if (event.kind === "trade") {
      written(await db.insert(junoTrades).values(tradeRow(event, row.token, at, chainId)).onConflictDoNothing().returning({ n: junoTrades.logIndex }));
      counts.trades += 1;
    } else if (event.kind === "creatorClaim" || event.kind === "lpFees") {
      written(await db.insert(junoClaims).values(claimRow(event, row.token, at, chainId)).onConflictDoNothing().returning({ n: junoClaims.logIndex }));
      counts.claims += 1;
    } else if (event.kind === "graduated") {
      written(
        await db.insert(junoGraduations).values(graduationRow(event, row.token, at, chainId)).onConflictDoNothing().returning({ n: junoGraduations.logIndex }),
      );
      counts.graduations += 1;
    }
  }
  for (const curve of touched) invalidateCurve(chainId, curve);
  return counts;
}

/* ------------------------------------------------------------------ */
/* Reading logs                                                        */
/* ------------------------------------------------------------------ */

function isRangeError(error: unknown): boolean {
  const message = error instanceof Error ? `${error.message} ${(error as { details?: string }).details ?? ""}` : String(error);
  return /range|too many|limit|exceed|10000|query returned more|block range|response size/i.test(message);
}

async function logsInRange(
  chainId: ChainId,
  factory: `0x${string}`,
  curves: string[],
  fromBlock: bigint,
  toBlock: bigint,
): Promise<Log[]> {
  const client = publicClient(chainId);
  const launched = await withRetry(() => client.getLogs({ address: factory, event: launchedEvent, fromBlock, toBlock }));
  // Curves launched inside this range have to be read too.
  const newCurves = launched
    .map((log) => ((log as unknown as { args: { curve?: string } }).args.curve ?? "").toLowerCase())
    .filter(Boolean);
  const addresses = [...new Set([...curves, ...newCurves])];
  const curveLogs: Log[] = [];
  for (let i = 0; i < addresses.length; i += ADDRESS_CHUNK) {
    const chunk = addresses.slice(i, i + ADDRESS_CHUNK) as `0x${string}`[];
    const logs = await withRetry(() => client.getLogs({ address: chunk, events: curveEvents, fromBlock, toBlock }));
    curveLogs.push(...(logs as Log[]));
  }
  return [...(launched as Log[]), ...curveLogs];
}

/** Write a range's logs. Launches first, so their curves' trades have a token to point at. */
export async function recordLogs(
  chainId: ChainId,
  factory: string,
  logs: Log[],
  curves: Map<string, Pick<CurveRow, "token">>,
): Promise<{
  launched: Array<{ token: string; curve: string }>;
  trades: number;
  claims: number;
  graduations: number;
  inserted: number;
}> {
  const events = decodeJunoLogs(logs, { factory, curves: curves.keys() });
  const launched: Array<{ token: string; curve: string }> = [];
  let newLaunches = 0;
  for (const event of events) {
    if (event.kind !== "launched") continue;
    if (await recordLaunch(chainId, event)) newLaunches += 1;
    curves.set(event.curve, { token: event.token });
    launched.push({ token: event.token, curve: event.curve });
  }
  const counts = await recordCurveEvents(chainId, events, curves);
  return { launched, ...counts, inserted: counts.inserted + newLaunches };
}

/* ------------------------------------------------------------------ */
/* Cursor                                                              */
/* ------------------------------------------------------------------ */

export async function readCursor(chainId: ChainId): Promise<number | null> {
  const [row] = await getDb().select().from(junoIndexCursor).where(eq(junoIndexCursor.chainId, chainId)).limit(1);
  return row?.lastBlock ?? null;
}

async function writeCursor(chainId: ChainId, lastBlock: number): Promise<void> {
  await getDb()
    .insert(junoIndexCursor)
    .values({ chainId, lastBlock, updatedAt: new Date() })
    .onConflictDoUpdate({ target: junoIndexCursor.chainId, set: { lastBlock, updatedAt: new Date() } });
}

/**
 * Where to start on a chain with no cursor: the configured factory block, or
 * the block the factory's code first appears in (binary search on
 * `eth_getCode`), or failing both, the last million blocks.
 */
export async function startBlock(chainId: ChainId, factory: `0x${string}`, latest: number): Promise<number> {
  const configured = factoryBlock(chainId);
  if (configured !== null) return configured;
  const client = publicClient(chainId);
  try {
    const hasCode = async (block: number) =>
      ((await client.getCode({ address: factory, blockNumber: BigInt(block) })) ?? "0x").length > 2;
    if (!(await hasCode(latest))) return latest;
    let low = 0;
    let high = latest;
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      if (await hasCode(mid)) high = mid;
      else low = mid + 1;
    }
    return low;
  } catch {
    return Math.max(0, latest - 1_000_000);
  }
}

/* ------------------------------------------------------------------ */
/* Metadata retries                                                    */
/* ------------------------------------------------------------------ */

async function refreshMetadata(chainId: ChainId, limit = 10): Promise<number> {
  const db = getDb();
  const rows = await db
    .select()
    .from(junoCurves)
    .where(sql`${junoCurves.chainId} = ${chainId} and ${junoCurves.metadataFetched} = false`)
    .limit(limit);
  let done = 0;
  for (const row of rows) {
    const raw = await fetchMetadata(row.metadataUri).catch(() => null);
    if (!raw) continue;
    const parsed = parseMetadata(raw);
    await db
      .update(junoCurves)
      .set({
        format: parsed.format,
        description: parsed.description,
        mediaUrl: parsed.mediaUrl,
        posterUrl: parsed.posterUrl,
        mediaMime: parsed.mediaMime,
        mediaWidth: parsed.mediaWidth,
        mediaHeight: parsed.mediaHeight,
        metadataFetched: true,
      })
      .where(eq(junoCurves.token, row.token));
    done += 1;
  }
  return done;
}

/* ------------------------------------------------------------------ */
/* The run                                                             */
/* ------------------------------------------------------------------ */

const running = new Map<ChainId, Promise<IndexReport>>();

export function runIndexer(chainId: ChainId, options: { maxBatches?: number } = {}): Promise<IndexReport> {
  const pending = running.get(chainId);
  if (pending) return pending;
  const run = indexOnce(chainId, options).finally(() => running.delete(chainId));
  running.set(chainId, run);
  return run;
}

async function indexOnce(chainId: ChainId, options: { maxBatches?: number }): Promise<IndexReport> {
  const { factory } = requireDeployment(chainId);
  const client = publicClient(chainId);
  const latest = Number(await withRetry(() => client.getBlockNumber()));
  const cursor = await readCursor(chainId);
  const first = cursor === null ? await startBlock(chainId, factory, latest) : Math.max(0, cursor - REORG_DEPTH + 1);

  const report: IndexReport = {
    chainId,
    from: first,
    to: null,
    latest,
    lag: 0,
    batches: 0,
    launched: 0,
    trades: 0,
    claims: 0,
    graduations: 0,
    metadataRefreshed: 0,
    newRows: 0,
    done: false,
  };

  const curves = new Map<string, Pick<CurveRow, "token">>();
  for (const [curve, row] of await knownCurves(chainId)) curves.set(curve, { token: row.token });

  const maxBatches = options.maxBatches ?? 40;
  let size = MAX_BATCH;
  let from = first;
  while (from <= latest && report.batches < maxBatches) {
    const to = Math.min(latest, from + size - 1);
    let logs: Log[];
    try {
      logs = await logsInRange(chainId, factory, [...curves.keys()], BigInt(from), BigInt(to));
    } catch (error) {
      if (isRangeError(error) && size > MIN_BATCH) {
        size = Math.max(MIN_BATCH, Math.floor(size / 2));
        continue;
      }
      throw error;
    }
    const written = await recordLogs(chainId, factory, logs, curves);
    report.launched += written.launched.length;
    report.trades += written.trades;
    report.claims += written.claims;
    report.graduations += written.graduations;
    report.newRows += written.inserted;
    report.batches += 1;
    report.to = to;
    await writeCursor(chainId, to);
    from = to + 1;
  }

  report.metadataRefreshed = await refreshMetadata(chainId).catch(() => 0);
  const reached = report.to ?? cursor ?? first - 1;
  report.lag = Math.max(0, latest - reached);
  report.done = reached >= latest;
  return report;
}

/** Cursor, head and lag, without indexing anything. */
export async function indexStatus(chainId: ChainId): Promise<{
  chainId: ChainId;
  lastBlock: number | null;
  latest: number | null;
  lag: number | null;
  factoryBlock: number | null;
  curves: number;
  trades: number;
}> {
  const db = getDb();
  const [lastBlock, latest, curveCount, tradeCount] = await Promise.all([
    readCursor(chainId),
    publicClient(chainId)
      .getBlockNumber()
      .then(Number)
      .catch(() => null),
    db.select({ n: sql<number>`count(*)::int` }).from(junoCurves).where(eq(junoCurves.chainId, chainId)),
    db.select({ n: sql<number>`count(*)::int` }).from(junoTrades).where(eq(junoTrades.chainId, chainId)),
  ]);
  return {
    chainId,
    lastBlock,
    latest,
    lag: lastBlock !== null && latest !== null ? Math.max(0, latest - lastBlock) : null,
    factoryBlock: factoryBlock(chainId),
    curves: curveCount[0]?.n ?? 0,
    trades: tradeCount[0]?.n ?? 0,
  };
}
