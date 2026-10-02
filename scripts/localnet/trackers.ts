/**
 * Launch the stock trackers on the local node: TSLA, NVDA and AAPL, each
 * quoted in the local test USDC and held to its feed's band. The metadata is
 * pinned through the local API like any launch (a session signed by the
 * deployer), so the trackers carry a real document, not a placeholder URI.
 * Skips a stock that already has a tracker. `npx tsx localnet/trackers.ts`
 */
import { decodeEventLog, type Hex } from "viem";

import { junoFactoryAbi } from "../../config/abi";
import { LOCAL_CHAIN_ID, TRACKER_MAX_AGE_SECONDS } from "../../config/addresses";
import { aggregatorAbi, clients } from "../lib";

const API = process.env.JUNO_LOCAL_API ?? "http://localhost:3131";
const { publicClient, walletClient, account, addresses } = clients(LOCAL_CHAIN_ID);
const STOCKS = [
  { symbol: "TSLA", name: "Tesla" },
  { symbol: "NVDA", name: "NVIDIA" },
  { symbol: "AAPL", name: "Apple" },
] as const;

async function api<T>(method: string, path: string, body?: unknown, token?: string): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${json.error ?? ""}`);
  return json;
}

const wallet = account.address.toLowerCase();
const issuedAt = new Date().toISOString();
const { token } = await api<{ token: string }>("POST", "/api/juno/session", {
  chainId: LOCAL_CHAIN_ID,
  wallet,
  issuedAt,
  signature: await account.signMessage({ message: `Juno session\nWallet: ${wallet}\nIssued: ${issuedAt}` }),
});

const stocks = await api<Array<{ symbol: string; trackers: unknown[] }>>("GET", `/api/juno/stocks?chainId=${LOCAL_CHAIN_ID}`);
for (const stock of STOCKS) {
  if ((stocks.find((s) => s.symbol === stock.symbol)?.trackers.length ?? 0) > 0) {
    console.log(`${stock.symbol}: tracker already listed`);
    continue;
  }
  const feed = addresses.feeds[stock.symbol] as Hex;
  const [, answer] = await publicClient.readContract({ address: feed, abi: aggregatorAbi, functionName: "latestRoundData" });
  const ref = (answer * 10n ** 6n) / 10n ** 8n; // USDC units per token
  const name = `${stock.name} Tracker`;
  const symbol = `j${stock.symbol}`;
  const pinned = await api<{ uri: string }>(
    "POST",
    "/api/juno/metadata",
    {
      name,
      symbol,
      description: `Tracks ${stock.name} (${stock.symbol}). Priced in USDC and held within 1% of the ${stock.symbol}/USD Chainlink feed; buys pause when the feed is stale.`,
      format: "post",
      creator: wallet,
      curvePreset: "tight-nav",
    },
    token,
  );
  const hash = await walletClient.writeContract({
    address: addresses.factory!,
    abi: junoFactoryAbi,
    functionName: "launchTracker",
    // 100 tokens; the curve runs 0.99x -> 1.04x the stock and the 1% band
    // cuts it off halfway: the top opens only as the stock rises.
    args: [{ name, symbol, metadataURI: pinned.uri, quote: addresses.usdc!, feed, bandBps: 100, maxAge: TRACKER_MAX_AGE_SECONDS, supply: 100n * 10n ** 18n, p0: (ref * 99n) / 100n, capFp: 1_040_000_000_000_000_000n }],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${symbol} launch reverted: ${hash}`);
  let curve = "";
  for (const log of receipt.logs) {
    try {
      const ev = decodeEventLog({ abi: junoFactoryAbi, data: log.data, topics: log.topics });
      if (ev.eventName === "Launched") curve = ev.args.curve;
    } catch {}
  }
  await api("POST", "/api/juno/tx/record", { chainId: LOCAL_CHAIN_ID, txHash: hash });
  console.log(`${symbol}: curve ${curve}  metadata ${pinned.uri}  tx ${hash}`);
}
