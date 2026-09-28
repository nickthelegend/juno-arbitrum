/**
 * Arbitrum One proof, run by the owner of the deployer key (never by an
 * agent). Prints every transaction before sending and waits for "yes".
 *
 *   1. launch a post (ETH) with a 0.0005 ETH first buy, then buy 0.001 ETH
 *   2. launch a TSLA tracker (Circle USDC, real Chainlink TSLA/USD feed)
 *   3. buy $2 of it inside the band
 *   4. show that a buy past the band reverts: eth_call only, no gas spent
 *
 * Needs, on the deployer: ~0.01 ETH and >= 2 USDC on Arbitrum One, and the
 * contracts deployed there (CHAIN=one bash scripts/deploy.sh).
 * Writes docs/mainnet-proof.log.
 */
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import {
  decodeEventLog,
  encodeFunctionData,
  erc20Abi,
  formatEther,
  formatUnits,
  parseEther,
  parseUnits,
  type Hex,
} from "viem";

import { junoCurveAbi, junoFactoryAbi } from "../config/abi";
import { TRACKER_MAX_AGE_SECONDS } from "../config/addresses";
import { aggregatorAbi, clients, explorerTx } from "./lib";

const CHAIN = 42161;
const { publicClient, walletClient, account, addresses } = clients(CHAIN);
if (!addresses.factory || !addresses.usdc || !addresses.feeds.TSLA) throw new Error("deploy to Arbitrum One first");
const factory = addresses.factory;
const usdc = addresses.usdc;
const tslaFeed = addresses.feeds.TSLA;
const rl = createInterface({ input: process.stdin, output: process.stdout });
const out: string[] = [`# Juno on Arbitrum One, ${new Date().toISOString()}`, `wallet ${account.address}`];
const deadline = () => BigInt(Math.floor(Date.now() / 1000) + 600);

async function send(label: string, to: Hex, data: Hex, value = 0n) {
  const gas = ((await publicClient.estimateGas({ account, to, data, value })) * 13n) / 10n;
  console.log(`\n${label}\n  to ${to}\n  value ${formatEther(value)} ETH\n  gas limit ${gas}\n  data ${data.slice(0, 74)}…`);
  if ((await rl.question("Send? (yes/no) ")).trim() !== "yes") throw new Error("stopped by user");
  const hash = await walletClient.sendTransaction({ to, data, value, gas });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${label} reverted ${hash}`);
  const line = `${label.padEnd(30)} ${explorerTx(CHAIN, hash)}`;
  console.log(line);
  out.push(line);
  return receipt;
}

function launchedFrom(receipt: Awaited<ReturnType<typeof send>>) {
  for (const l of receipt.logs) {
    try {
      const ev = decodeEventLog({ abi: junoFactoryAbi, data: l.data, topics: l.topics });
      if (ev.eventName === "Launched") return ev.args;
    } catch {}
  }
  throw new Error("no Launched event");
}

console.log(`Wallet ${account.address}: ${formatEther(await publicClient.getBalance({ address: account.address }))} ETH, ${formatUnits(await publicClient.readContract({ address: usdc, abi: erc20Abi, functionName: "balanceOf", args: [account.address] }), 6)} USDC`);

// 1. a post
const ethUsd = await publicClient.readContract({ address: "0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612", abi: aggregatorAbi, functionName: "latestRoundData" });
const p0 = parseEther("1") / 1_000_000_000n; // 1 ETH initial market cap
let r = await send(
  "launch post + first buy",
  factory,
  encodeFunctionData({ abi: junoFactoryAbi, functionName: "launch", args: [{ name: "Juno on Arbitrum", symbol: "JUNO", metadataURI: "ipfs://bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku", preset: 0, quote: "0x0000000000000000000000000000000000000000", p0, capFp: 25n * 10n ** 18n }, 0n] }),
  parseEther("0.0005"),
);
const post = launchedFrom(r);
out.push(`  post curve ${post.curve}  token ${post.token}  pool ${post.pool}  (ETH $${Number(ethUsd[1]) / 1e8})`);
await send("buy 0.001 ETH", post.curve, encodeFunctionData({ abi: junoCurveAbi, functionName: "buy", args: [0n, deadline()] }), parseEther("0.001"));

// 2. a TSLA tracker on the real feed
const [, answer, , updatedAt] = await publicClient.readContract({ address: tslaFeed, abi: aggregatorAbi, functionName: "latestRoundData" });
const ref = (answer * 10n ** 6n) / 10n ** 8n;
const age = Math.round(Date.now() / 1000 - Number(updatedAt));
out.push(`Chainlink TSLA/USD $${formatUnits(ref, 6)}, updated ${age}s ago`);
if (age > TRACKER_MAX_AGE_SECONDS) console.log("WARNING: the TSLA feed is stale (market closed): the tracker will refuse buys. Run this during US market hours.");
r = await send(
  "launch TSLA tracker (USDC)",
  factory,
  encodeFunctionData({ abi: junoFactoryAbi, functionName: "launchTracker", args: [{ name: "Tesla Tracker", symbol: "jTSLA", metadataURI: "ipfs://tsla-tracker", quote: usdc, feed: tslaFeed, bandBps: 100, maxAge: TRACKER_MAX_AGE_SECONDS, supply: 100n * 10n ** 18n, p0: (ref * 99n) / 100n, capFp: 1_040_000_000_000_000_000n }] }),
);
const tracker = launchedFrom(r);
out.push(`  tracker curve ${tracker.curve}  token ${tracker.token}`);

// 3. $2 inside the band
const two = parseUnits("2", 6);
await send("approve 2 USDC", usdc, encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [tracker.curve, two] }));
await send("buy $2 of jTSLA (in band)", tracker.curve, encodeFunctionData({ abi: junoCurveAbi, functionName: "buyWithQuote", args: [two, 0n, deadline()] }));

// 4. past the band: the curve's own quote view, so it costs nothing. (A
// simulated buy would stop at the USDC transfer before reaching the check.)
const past = await publicClient.readContract({ address: tracker.curve, abi: junoCurveAbi, functionName: "quoteBuy", args: [parseUnits("9500", 6)] });
out.push(`  $9,500 buy: the contract quotes bandOk=${past.bandOk}, price after $${formatUnits(past.priceAfter, 6)} vs TSLA $${formatUnits(past.refPrice, 6)} + 1% (buyWithQuote would revert OutsideBand)`);

rl.close();
appendFileSync(fileURLToPath(new URL("../docs/mainnet-proof.log", import.meta.url)), out.join("\n") + "\n\n");
console.log("\n" + out.join("\n") + "\n\nwritten to docs/mainnet-proof.log");
