/**
 * End-to-end smoke test on Arbitrum Sepolia, from the deployer's key and a
 * fresh trader wallet it funds. Proves every contract path with real
 * transactions and writes the hashes to docs/sepolia-proof.log:
 *
 *   post launch (ETH) -> buy -> sell (no approve) -> creator claim
 *   tracker launch (USDC, TSLA feed) -> in-band buy -> out-of-band buy reverts
 *   small post filled -> graduate into Uniswap v3
 *
 *   tsx smoke.ts            (RPC_OVERRIDE=http://127.0.0.1:8545 for a local fork)
 */
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  BaseError,
  ContractFunctionRevertedError,
  createWalletClient,
  decodeEventLog,
  formatEther,
  formatUnits,
  http,
  parseEther,
  parseUnits,
  type Hash,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { junoCurveAbi, junoFactoryAbi, testUsdcAbi, curveMathAbi } from "../config/abi";
import { TRACKER_MAX_AGE_SECONDS } from "../config/addresses";
import { aggregatorAbi, chainFor, clients, explorerTx } from "./lib";

const CHAIN = 421614;
const { publicClient, walletClient: deployer, account, addresses } = clients(CHAIN);
if (!addresses.factory || !addresses.usdc || !addresses.curveMath || !addresses.feeds.TSLA) {
  throw new Error("deploy first (config/addresses.ts has no factory for 421614)");
}
const factory = addresses.factory;
const usdc = addresses.usdc;
const log = fileURLToPath(new URL("../docs/sepolia-proof.log", import.meta.url));
const local = !!process.env.RPC_OVERRIDE;

const lines: string[] = [];
function note(line: string) {
  console.log(line);
  lines.push(line);
}

async function sent(label: string, hash: Hash) {
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${label} reverted: ${hash}`);
  note(`${label.padEnd(34)} ${local ? hash : explorerTx(CHAIN, hash)}`);
  return receipt;
}

function launched(receipt: Awaited<ReturnType<typeof sent>>) {
  for (const l of receipt.logs) {
    try {
      const ev = decodeEventLog({ abi: junoFactoryAbi, data: l.data, topics: l.topics });
      if (ev.eventName === "Launched") return ev.args;
    } catch {}
  }
  throw new Error("no Launched event");
}

const deadline = () => BigInt(Math.floor(Date.now() / 1000) + 600);

// SMOKE_SELF=1: the deployer trades too (a thin test-ETH budget). Otherwise a
// fresh trader is funded by the deployer.
const self = process.env.SMOKE_SELF === "1";
const skipGraduation = process.env.SKIP_GRADUATION === "1";
const buyEth = process.env.BUY_ETH ?? "0.002";
// GRAD_ONLY=1 runs only step 3; GRAD_P0 sets the tiny post's starting price in
// wei per token (default 1e6: ~0.0028 ETH to fill; 3e4 fills for ~0.0001 ETH).
const gradOnly = process.env.GRAD_ONLY === "1";
const gradP0 = BigInt(process.env.GRAD_P0 ?? "1000000");
const trader = self ? account : privateKeyToAccount(generatePrivateKey());
const traderClient = self ? deployer : createWalletClient({ chain: deployer.chain, transport: http(chainFor(CHAIN).rpc), account: trader });
note(`# Juno smoke test, ${new Date().toISOString()}${local ? " (local fork)" : ""}`);
note(`deployer ${account.address}  trader ${trader.address}`);
if (!self) await sent("fund trader 0.03 ETH", await deployer.sendTransaction({ to: trader.address, value: parseEther("0.03") }));

let r: Awaited<ReturnType<typeof sent>>;
if (!gradOnly) {
// ---- 1. a post, priced in ETH
const p0 = 20_000_000n; // 0.02 ETH initial market cap at 1B supply
r = await sent(
  "launch post (content, ETH)",
  await deployer.writeContract({
    address: factory,
    abi: junoFactoryAbi,
    functionName: "launch",
    args: [{ name: "Smoke Test", symbol: "SMOKE", metadataURI: "ipfs://smoke", preset: 0, quote: "0x0000000000000000000000000000000000000000", p0, capFp: 25n * 10n ** 18n }, 0n],
  }),
);
const post = launched(r);
note(`  curve ${post.curve}  token ${post.token}  pool ${post.pool}`);

const q = await publicClient.readContract({ address: post.curve, abi: junoCurveAbi, functionName: "quoteBuy", args: [parseEther(buyEth)] });
await sent(
  `buy ${buyEth} ETH`,
  await traderClient.writeContract({ address: post.curve, abi: junoCurveAbi, functionName: "buy", args: [(q.tokensOut * 99n) / 100n, deadline()], value: parseEther(buyEth) }),
);
const half = q.tokensOut / 2n;
const sq = await publicClient.readContract({ address: post.curve, abi: junoCurveAbi, functionName: "quoteSell", args: [half] });
await sent(
  "sell half, no approve",
  await traderClient.writeContract({ address: post.curve, abi: junoCurveAbi, functionName: "sell", args: [half, (sq.quoteOut * 99n) / 100n, deadline()] }),
);
const owed = (await publicClient.readContract({ address: post.curve, abi: junoCurveAbi, functionName: "state" })).creatorFees;
await sent(`creator claims ${formatEther(owed)} ETH`, await deployer.writeContract({ address: post.curve, abi: junoCurveAbi, functionName: "claimCreatorFees" }));

// ---- 2. a TSLA tracker, priced in USDC, held to the Chainlink band
const [, answer, , updatedAt] = await publicClient.readContract({ address: addresses.feeds.TSLA!, abi: aggregatorAbi, functionName: "latestRoundData" });
const ref = (answer * 10n ** 6n) / 10n ** 8n; // USDC units per token
note(`TSLA reference $${formatUnits(ref, 6)} (age ${Math.round(Date.now() / 1000 - Number(updatedAt))}s)`);
r = await sent(
  "launch TSLA tracker (USDC)",
  await deployer.writeContract({
    address: factory,
    abi: junoFactoryAbi,
    functionName: "launchTracker",
    // 100 tokens; the curve runs 0.99x -> 1.04x the stock, and the 1% band
    // cuts it off halfway: the top of the curve opens only as the stock rises.
    args: [{ name: "Tesla Tracker", symbol: "jTSLA", metadataURI: "ipfs://tsla", quote: usdc, feed: addresses.feeds.TSLA!, bandBps: 100, maxAge: TRACKER_MAX_AGE_SECONDS, supply: 100n * 10n ** 18n, p0: (ref * 99n) / 100n, capFp: 1_040_000_000_000_000_000n }],
  }),
);
const tracker = launched(r);
note(`  curve ${tracker.curve}  token ${tracker.token}`);
await sent("trader mints 10,000 test USDC", await traderClient.writeContract({ address: usdc, abi: testUsdcAbi, functionName: "mint", args: [trader.address, parseUnits("10000", 6)] }));
await sent("approve USDC", await traderClient.writeContract({ address: usdc, abi: testUsdcAbi, functionName: "approve", args: [tracker.curve, 2n ** 256n - 1n] }));
const tq = await publicClient.readContract({ address: tracker.curve, abi: junoCurveAbi, functionName: "quoteBuy", args: [parseUnits("500", 6)] });
note(`  quote $500: ${formatUnits(tq.tokensOut, 18)} jTSLA, band ok ${tq.bandOk}, market open ${tq.marketOpen}`);
if (tq.marketOpen) {
  await sent("in-band buy $500", await traderClient.writeContract({ address: tracker.curve, abi: junoCurveAbi, functionName: "buyWithQuote", args: [parseUnits("500", 6), 0n, deadline()] }));
} else {
  note("  market closed: the in-band buy is refused on-chain, as designed (run keep-feeds-fresh --force-open to demo buys)");
}

// An out-of-band buy: ~25 of the 50 curve tokens would lift it past 1.01 x the stock.
const big = parseUnits("9500", 6);
try {
  await publicClient.simulateContract({ address: tracker.curve, abi: junoCurveAbi, functionName: "buyWithQuote", args: [big, 0n, deadline()], account: trader });
  note("  WARNING: out-of-band buy did not revert");
} catch (e: any) {
  const reverted = e instanceof BaseError ? e.walk((x) => x instanceof ContractFunctionRevertedError) : null;
  const err = reverted instanceof ContractFunctionRevertedError ? reverted.data : undefined;
  const detail = err ? `${err.errorName}(${(err.args ?? []).map((a) => String(a)).join(", ")})` : (e.shortMessage ?? String(e));
  note(`  $9,500 buy refused by the contract: ${detail}`);
}

}

// ---- 3. fill a tiny post and graduate it into Uniswap v3
if (skipGraduation) {
  note("graduation skipped (SKIP_GRADUATION=1: not enough test ETH for a third launch + fill)");
  if (!local) appendFileSync(log, lines.join("\n") + "\n\n");
  process.exit(0);
}
r = await sent(
  "launch tiny post (fill target)",
  await deployer.writeContract({
    address: factory,
    abi: junoFactoryAbi,
    functionName: "launch",
    args: [{ name: "Graduation Test", symbol: "GRAD", metadataURI: "ipfs://grad", preset: 0, quote: "0x0000000000000000000000000000000000000000", p0: gradP0, capFp: 25n * 10n ** 18n }, 0n],
  }),
);
const tiny = launched(r);
const full = await publicClient.readContract({ address: addresses.curveMath, abi: curveMathAbi, functionName: "costToBuy", args: [0, gradP0, 25n * 10n ** 18n, tiny.curveSupply, 0n, tiny.curveSupply] });
const gross = (full * 10_000n) / 9_000n + 1_000_000n; // fee on top, change comes back
note(`  filling costs ${formatEther(full)} ETH before fees`);
await sent("buy the whole curve", await traderClient.writeContract({ address: tiny.curve, abi: junoCurveAbi, functionName: "buy", args: [0n, deadline()], value: gross }));
// Explicit gas: estimates run short on the nested Uniswap mint (63/64 rule).
r = await sent("graduate into Uniswap v3", await traderClient.writeContract({ address: tiny.curve, abi: junoCurveAbi, functionName: "graduate", gas: 3_000_000n }));
for (const l of r.logs) {
  try {
    const ev = decodeEventLog({ abi: junoCurveAbi, data: l.data, topics: l.topics });
    if (ev.eventName === "Graduated") note(`  pool ${ev.args.pool}  position #${ev.args.positionId}  ${formatEther(ev.args.quoteLiquidity)} WETH + ${formatEther(ev.args.tokenLiquidity)} GRAD, burned ${formatEther(ev.args.burned)}`);
  } catch {}
}

if (!local) appendFileSync(log, lines.join("\n") + "\n\n");
console.log(local ? "\nlocal fork: nothing written" : `\nwritten to docs/sepolia-proof.log`);
