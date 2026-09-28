import "server-only";

import { readFileSync } from "node:fs";
import path from "node:path";

import { createPublicClient, fallback, http, type Chain, type PublicClient } from "viem";
import { arbitrum, arbitrumSepolia } from "viem/chains";

import { ADDRESSES, APP_CHAIN_ID, type ChainAddresses } from "@config/addresses";
import { CallerError } from "./api";
import type { Address } from "./address";

/**
 * The two chains Juno runs on, and how to reach them.
 *
 * Arbitrum Sepolia is the app's network. Arbitrum One is read-only for the
 * app (the mainnet proof is sent by scripts) and is also where the ETH/USD
 * reference price is read, for both chains.
 */

export const SEPOLIA = 421614 as const;
export const ONE = 42161 as const;
export type ChainId = typeof SEPOLIA | typeof ONE;
export const SUPPORTED_CHAINS: readonly ChainId[] = [SEPOLIA, ONE];

const VIEM_CHAINS: Record<ChainId, Chain> = { [SEPOLIA]: arbitrumSepolia, [ONE]: arbitrum };

const PUBLIC_RPC: Record<ChainId, string> = {
  [SEPOLIA]: "https://sepolia-rollup.arbitrum.io/rpc",
  [ONE]: "https://arb1.arbitrum.io/rpc",
};

const RPC_ENV: Record<ChainId, string> = { [SEPOLIA]: "ARB_SEPOLIA_RPC", [ONE]: "ARB_ONE_RPC" };

/* ------------------------------------------------------------------ */
/* The address book                                                    */
/* ------------------------------------------------------------------ */

let localBook: Record<string, Partial<ChainAddresses>> | null | undefined;

/**
 * `config/addresses.local.json`, merged over `config/addresses.ts` when
 * `JUNO_LOCAL_ADDRESSES=1` — the contracts on a local anvil fork. Never used
 * unless asked for, so a stray file cannot redirect a deployed server.
 */
function localAddresses(): Record<string, Partial<ChainAddresses>> | null {
  if (process.env.JUNO_LOCAL_ADDRESSES !== "1") return null;
  if (localBook !== undefined) return localBook;
  const file =
    process.env.JUNO_LOCAL_ADDRESSES_PATH ??
    path.join(/*turbopackIgnore: true*/ process.cwd(), "..", "config", "addresses.local.json");
  try {
    localBook = JSON.parse(readFileSync(/*turbopackIgnore: true*/ file, "utf8")) as Record<string, Partial<ChainAddresses>>;
  } catch (error) {
    console.warn("[juno] JUNO_LOCAL_ADDRESSES=1 but", file, "could not be read:", (error as Error).message);
    localBook = null;
  }
  return localBook;
}

/** This chain's addresses: the generated book, with local overrides when enabled. */
export function book(chainId: ChainId): ChainAddresses {
  const base = ADDRESSES[chainId];
  const local = localAddresses()?.[String(chainId)];
  if (!local) return base;
  return { ...base, ...local, feeds: { ...base.feeds, ...(local.feeds ?? {}) } };
}

export function appChainId(): ChainId {
  const fromEnv = Number(process.env.APP_CHAIN_ID);
  if (fromEnv === SEPOLIA || fromEnv === ONE) return fromEnv;
  return APP_CHAIN_ID as ChainId;
}

export function isSupportedChain(value: number): value is ChainId {
  return value === SEPOLIA || value === ONE;
}

/** A `chainId` from a query string or body; the app chain when absent. */
export function resolveChainId(value: unknown): ChainId {
  if (value === undefined || value === null || value === "") return appChainId();
  const n = Number(value);
  if (!isSupportedChain(n)) {
    throw new CallerError(`Unsupported chainId ${String(value)}. One of: ${SUPPORTED_CHAINS.join(", ")}`);
  }
  return n;
}

export function chainIdFromUrl(url: URL): ChainId {
  return resolveChainId(url.searchParams.get("chainId"));
}

/**
 * Keyed RPC first when configured, the public endpoint as the fallback. A
 * local node (an anvil fork) is used alone: falling back from a fork to the
 * real chain would mix two different states.
 */
export function rpcUrls(chainId: ChainId): string[] {
  const configured = process.env[RPC_ENV[chainId]]?.trim();
  if (configured && /^https?:\/\/(127\.0\.0\.1|localhost|0\.0\.0\.0)(:|\/|$)/.test(configured)) return [configured];
  return [...new Set([configured, PUBLIC_RPC[chainId]].filter((url): url is string => !!url))];
}

export function usingPublicRpc(chainId: ChainId): boolean {
  return !process.env[RPC_ENV[chainId]]?.trim();
}

const clients = new Map<ChainId, PublicClient>();

/**
 * One viem client per chain. Reads made in the same tick are folded into a
 * single Multicall3 call, which is what keeps a feed of forty curves to a
 * handful of round trips.
 */
export function publicClient(chainId: ChainId): PublicClient {
  let client = clients.get(chainId);
  if (!client) {
    client = createPublicClient({
      chain: VIEM_CHAINS[chainId],
      transport: fallback(
        rpcUrls(chainId).map((url) => http(url, { retryCount: 1, retryDelay: 400, timeout: 20_000 })),
        { rank: false },
      ),
      batch: { multicall: { wait: 8, batchSize: 4_096 } },
    }) as PublicClient;
    clients.set(chainId, client);
  }
  return client;
}

export function viemChain(chainId: ChainId): Chain {
  return VIEM_CHAINS[chainId];
}

export function chainAddresses(chainId: ChainId): ChainAddresses {
  return book(chainId);
}

export function chainName(chainId: ChainId): string {
  return book(chainId)?.name ?? `chain ${chainId}`;
}

export type Deployment = {
  chainId: ChainId;
  factory: Address;
  curveMath: Address | null;
  usdc: Address | null;
  weth: Address;
  feeds: Partial<Record<string, Address>>;
};

function lower(value: string | null | undefined): Address | null {
  return value ? (value.toLowerCase() as Address) : null;
}

/** Juno's contracts on this chain, or null when they are not deployed yet. */
export function deployment(chainId: ChainId): Deployment | null {
  const entry = book(chainId);
  if (!entry?.factory) return null;
  const feeds: Partial<Record<string, Address>> = {};
  for (const [symbol, feed] of Object.entries(entry.feeds ?? {})) {
    if (feed) feeds[symbol] = feed.toLowerCase() as Address;
  }
  return {
    chainId,
    factory: lower(entry.factory)!,
    curveMath: lower(entry.curveMath),
    usdc: lower(entry.usdc),
    weth: lower(entry.weth)!,
    feeds,
  };
}

/** The same, or a clean 503 a client can show: nothing to trade here yet. */
export function requireDeployment(chainId: ChainId): Deployment {
  const found = deployment(chainId);
  if (!found) {
    throw new CallerError(
      `Juno is not deployed on this chain yet (${chainName(chainId)}, ${chainId}).`,
      503,
      { chainId, deployed: false },
    );
  }
  return found;
}

/** Chainlink equity feeds for this chain, lowercased, by symbol. */
export function stockFeeds(chainId: ChainId): Array<{ symbol: string; feed: Address }> {
  return Object.entries(book(chainId)?.feeds ?? {})
    .filter((entry): entry is [string, `0x${string}`] => !!entry[1])
    .map(([symbol, feed]) => ({ symbol, feed: feed.toLowerCase() as Address }));
}

export function refSymbolForFeed(chainId: ChainId, feed: string | null): string | null {
  if (!feed) return null;
  const hit = stockFeeds(chainId).find((entry) => entry.feed === feed.toLowerCase());
  return hit?.symbol ?? null;
}

/**
 * The first block worth indexing: `JUNO_FACTORY_BLOCK_<chainId>`, or a
 * `factoryBlock` the deploy script may record next to the addresses.
 */
export function factoryBlock(chainId: ChainId): number | null {
  const fromEnv = Number(process.env[`JUNO_FACTORY_BLOCK_${chainId}`]);
  if (Number.isInteger(fromEnv) && fromEnv > 0) return fromEnv;
  const recorded = book(chainId)?.factoryBlock;
  return typeof recorded === "number" && recorded > 0 ? recorded : null;
}

/* ------------------------------------------------------------------ */
/* Links — the proof a judge clicks                                    */
/* ------------------------------------------------------------------ */

export function explorerBase(chainId: ChainId): string {
  return book(chainId)?.explorer ?? "https://sepolia.arbiscan.io";
}

export const explorer = {
  tx: (chainId: ChainId, hash: string) => `${explorerBase(chainId)}/tx/${hash}`,
  address: (chainId: ChainId, address: string) => `${explorerBase(chainId)}/address/${address}`,
  token: (chainId: ChainId, token: string) => `${explorerBase(chainId)}/token/${token}`,
};

/**
 * Where a graduated coin trades. Uniswap's app serves Arbitrum One; on
 * Sepolia there is no page to link to, so the pool's explorer page stands in.
 */
export function uniswapUrl(chainId: ChainId, token: string, pool: string): string {
  if (chainId === ONE) return `https://app.uniswap.org/explore/tokens/arbitrum/${token}`;
  return explorer.address(chainId, pool);
}
