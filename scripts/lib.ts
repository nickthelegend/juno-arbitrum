/**
 * Shared setup for Juno's operator scripts: env, chains, clients, the
 * deployer account. Secrets come from ../.env and are never printed.
 */
import { config as loadEnv } from "dotenv";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, defineChain, http, type Chain } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrum, arbitrumSepolia } from "viem/chains";

import { ADDRESSES, LOCAL_CHAIN_ID } from "../config/addresses";

loadEnv({ path: fileURLToPath(new URL("../.env", import.meta.url)) });

export function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}

export function chainFor(id: number): { chain: Chain; rpc: string } {
  if (id === 421614) return { chain: arbitrumSepolia, rpc: process.env.RPC_OVERRIDE ?? need("ARB_SEPOLIA_RPC") };
  if (id === 42161) return { chain: arbitrum, rpc: process.env.RPC_OVERRIDE ?? need("ARB_ONE_RPC") };
  if (id === LOCAL_CHAIN_ID) {
    const rpc = process.env.ARB_LOCAL_RPC ?? "http://localhost:8747";
    return { chain: localChain(rpc), rpc };
  }
  throw new Error(`unsupported chain ${id}`);
}

export function clients(id: number, keyEnv = "DEPLOYER_PRIVATE_KEY") {
  const { chain, rpc } = chainFor(id);
  const transport = http(rpc, { retryCount: 4, retryDelay: 800 });
  const publicClient = createPublicClient({ chain, transport });
  const account = privateKeyToAccount(need(keyEnv) as `0x${string}`);
  const walletClient = createWalletClient({ chain, transport, account });
  return { chain, publicClient, walletClient, account, addresses: addressesFor(id) };
}

/**
 * On a local fork (RPC_OVERRIDE set) the deployed addresses come from
 * config/addresses.local.json, so a rehearsal never touches the real book.
 */
export function addressesFor(id: number) {
  const local = fileURLToPath(new URL("../config/addresses.local.json", import.meta.url));
  if (process.env.RPC_OVERRIDE && existsSync(local)) {
    const overlay = JSON.parse(readFileSync(local, "utf8"))[id] ?? {};
    return { ...ADDRESSES[id], ...overlay, feeds: { ...ADDRESSES[id].feeds, ...(overlay.feeds ?? {}) } };
  }
  return ADDRESSES[id];
}

export function oneClient() {
  return createPublicClient({ chain: arbitrum, transport: http(need("ARB_ONE_RPC"), { retryCount: 4 }) });
}

export const aggregatorAbi = [
  {
    type: "function",
    name: "latestRoundData",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "roundId", type: "uint80" },
      { name: "answer", type: "int256" },
      { name: "startedAt", type: "uint256" },
      { name: "updatedAt", type: "uint256" },
      { name: "answeredInRound", type: "uint80" },
    ],
  },
] as const;

/** The real Arbitrum One equity feeds the Sepolia mocks mirror. */
export const ONE_FEEDS = ADDRESSES[42161].feeds as Record<"TSLA" | "NVDA" | "AAPL", `0x${string}`>;

export function explorerTx(id: number, hash: string) {
  return `${ADDRESSES[id].explorer}/tx/${hash}`;
}

/** A local Arbitrum Nitro dev node (chain 412346), with Stylus. */
export function localChain(rpc = process.env.ARB_LOCAL_RPC ?? "http://localhost:8747"): Chain {
  return defineChain({
    id: LOCAL_CHAIN_ID,
    name: "Arbitrum Local",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpc] } },
  });
}
