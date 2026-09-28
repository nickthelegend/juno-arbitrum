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
 *   tsx keep-feeds-fresh.ts --every-change  write on every new round
 *
 * To save test ETH a mock is only rewritten when the real price has moved at
 * least FEED_DEVIATION_BPS (default 50 = 0.5%) or the mock's updatedAt is
 * FEED_MAX_LAG_HOURS (default 4) behind the real one. Signs with
 * KEEPER_PRIVATE_KEY when set (the mocks' owner; see .github/workflows/feeds.yml),
 * else DEPLOYER_PRIVATE_KEY.
 */
import { mockAggregatorAbi } from "../config/abi";
import { aggregatorAbi, clients, explorerTx, ONE_FEEDS, oneClient } from "./lib";

const forceOpen = process.argv.includes("--force-open");
const watch = process.argv.includes("--watch");
const everyChange = process.argv.includes("--every-change");
const deviationBps = BigInt(process.env.FEED_DEVIATION_BPS ?? "50");
const maxLag = BigInt(Math.round(Number(process.env.FEED_MAX_LAG_HOURS ?? "4") * 3600));
const { publicClient, walletClient, addresses } = clients(421614, process.env.KEEPER_PRIVATE_KEY ? "KEEPER_PRIVATE_KEY" : "DEPLOYER_PRIVATE_KEY");
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
    const moved = mockAnswer === 0n ? deviationBps : ((answer > mockAnswer ? answer - mockAnswer : mockAnswer - answer) * 10_000n) / mockAnswer;
    if (!forceOpen && !everyChange && moved < deviationBps && stamp - mockUpdated < maxLag) {
      console.log(`${symbol} within ${moved} bps and ${stamp - mockUpdated}s of the real feed; left as is`);
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
