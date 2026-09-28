/**
 * Keep the Sepolia MockAggregators in step with the real Chainlink equity
 * feeds on Arbitrum One: same answer, same updatedAt. So when the US market
 * closes and the real feed stops moving, the Sepolia trackers go stale (and
 * refuse buys) on the same schedule.
 *
 *   tsx keep-feeds-fresh.ts            one pass
 *   tsx keep-feeds-fresh.ts --watch    every 10 minutes
 *   tsx keep-feeds-fresh.ts --force-open   stamp updatedAt = now (demo recording
 *                                      outside market hours; say so on screen)
 */
import { mockAggregatorAbi } from "../config/abi";
import { aggregatorAbi, clients, explorerTx, ONE_FEEDS, oneClient } from "./lib";

const forceOpen = process.argv.includes("--force-open");
const watch = process.argv.includes("--watch");
const { publicClient, walletClient, addresses } = clients(421614);
const one = oneClient();

async function pass() {
  for (const symbol of ["TSLA", "NVDA", "AAPL"] as const) {
    const mock = addresses.feeds[symbol];
    if (!mock) throw new Error(`no Sepolia mock for ${symbol}; deploy first`);
    const [, answer, , updatedAt] = await one.readContract({
      address: ONE_FEEDS[symbol],
      abi: aggregatorAbi,
      functionName: "latestRoundData",
    });
    const [, mockAnswer, , mockUpdated] = await publicClient.readContract({
      address: mock,
      abi: aggregatorAbi,
      functionName: "latestRoundData",
    });
    const stamp = forceOpen ? BigInt(Math.floor(Date.now() / 1000)) : updatedAt;
    if (mockAnswer === answer && mockUpdated === stamp) {
      console.log(`${symbol} unchanged ${Number(answer) / 1e8}`);
      continue;
    }
    const hash = await walletClient.writeContract({
      address: mock,
      abi: mockAggregatorAbi,
      functionName: "setAnswer",
      args: [answer, stamp],
    });
    await publicClient.waitForTransactionReceipt({ hash });
    const age = Math.round(Date.now() / 1000 - Number(stamp));
    console.log(`${symbol} ${Number(answer) / 1e8} (age ${age}s${forceOpen ? ", forced open" : ""}) ${explorerTx(421614, hash)}`);
  }
}

await pass();
if (watch) setInterval(() => pass().catch((e) => console.error(e.shortMessage ?? e)), 10 * 60 * 1000);
