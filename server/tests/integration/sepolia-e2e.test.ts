import { beforeAll, describe, expect, it } from "vitest";
import {
  createTestClient,
  createWalletClient,
  http,
  parseAbi,
  parseEther,
  parseUnits,
  type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { arbitrumSepolia } from "viem/chains";

import { junoCurveAbi } from "@config/abi";
import { deployment, publicClient, rpcUrls, SEPOLIA } from "@/lib/juno/chains";

/**
 * End to end against Arbitrum Sepolia, through the real route handlers:
 * index → feed → coin → quote → build → send → `tx/record` → read back.
 *
 * Runs wherever `ARB_SEPOLIA_RPC` points:
 * - a local anvil fork (`source scripts/fork-env.sh`): a fresh key is funded
 *   with `anvil_setBalance`, and every step really sends;
 * - real Arbitrum Sepolia: needs `JUNO_TEST_PRIVATE_KEY` (a funded test key),
 *   otherwise the sending half is skipped.
 *
 * Skipped entirely while `config/addresses.ts` has no Sepolia factory.
 */

const deployed = deployment(SEPOLIA);
const rpc = rpcUrls(SEPOLIA)[0];
const isLocal = /127\.0\.0\.1|localhost/.test(rpc);
const testKey = process.env.JUNO_TEST_PRIVATE_KEY as Hex | undefined;
const canSend = !!deployed && (isLocal || !!testKey);

const account = privateKeyToAccount(isLocal ? generatePrivateKey() : (testKey ?? generatePrivateKey()));
const wallet = account.address.toLowerCase();
const client = publicClient(SEPOLIA);
const signer = createWalletClient({ account, chain: arbitrumSepolia, transport: http(rpc) });

const routes = {
  index: () => import("@/app/api/juno/index/route"),
  coins: () => import("@/app/api/juno/coins/route"),
  coin: () => import("@/app/api/juno/coins/[address]/route"),
  feed: () => import("@/app/api/juno/feed/route"),
  swap: () => import("@/app/api/juno/tx/swap/route"),
  launch: () => import("@/app/api/juno/tx/launch/route"),
  claim: () => import("@/app/api/juno/tx/claim/route"),
  graduate: () => import("@/app/api/juno/tx/graduate/route"),
  record: () => import("@/app/api/juno/tx/record/route"),
  balance: () => import("@/app/api/juno/tx/balance/route"),
  stocks: () => import("@/app/api/juno/stocks/route"),
  portfolio: () => import("@/app/api/juno/portfolio/[wallet]/route"),
  leaderboard: () => import("@/app/api/juno/leaderboard/route"),
  depth: () => import("@/app/api/juno/depth/route"),
};

const url = (path: string) => `http://juno.test${path}`;
async function get(handler: (r: Request, c?: never) => Promise<Response>, path: string, params?: Record<string, string>) {
  const response = await handler(new Request(url(path)), (params ? { params: Promise.resolve(params) } : undefined) as never);
  return { status: response.status, body: (await response.json()) as any };
}
async function post(handler: (r: Request) => Promise<Response>, path: string, body: unknown) {
  const response = await handler(
    new Request(url(path), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  );
  return { status: response.status, body: (await response.json()) as any };
}

type Step = { label: string; to: Hex; data: Hex; value: string; gas: string };

/** Send a build's steps in order, as the app does, and return the last hash. */
async function send(steps: Step[]): Promise<Hex> {
  let last: Hex | null = null;
  for (const step of steps) {
    const hash = await signer.sendTransaction({
      to: step.to,
      data: step.data,
      value: BigInt(step.value),
      gas: BigInt(step.gas),
    });
    const receipt = await client.waitForTransactionReceipt({ hash });
    expect(receipt.status, `${step.label} reverted`).toBe("success");
    last = hash;
  }
  return last!;
}

async function record(hash: Hex) {
  const { POST } = await routes.record();
  return post(POST, "/api/juno/tx/record", { chainId: SEPOLIA, txHash: hash });
}

describe.skipIf(!deployed)("Arbitrum Sepolia: read side", () => {
  it("indexes the factory and its curves", async () => {
    const { POST, GET } = await routes.index();
    const run = await post(POST, "/api/juno/index?chainId=421614&batches=400", {});
    expect(run.status).toBe(200);
    expect(run.body.done).toBe(true);
    const status = await get(GET, "/api/juno/index?chainId=421614");
    expect(status.body.lag).toBeLessThanOrEqual(5);
    expect(status.body.curves).toBeGreaterThan(0);
  });

  it("lists priced coins and the feed", async () => {
    const { GET } = await routes.coins();
    const list = await get(GET, "/api/juno/coins?limit=50&nav=1");
    expect(list.status).toBe(200);
    expect(list.body.missing).toBe(0);
    for (const coin of list.body.coins) {
      expect(coin.address).toMatch(/^0x[0-9a-f]{40}$/);
      expect(coin.pool).toMatch(/^0x[0-9a-f]{40}$/);
      expect(coin.priceQuote).toBeGreaterThan(0);
      expect(coin.curve.progress).toBeGreaterThanOrEqual(0);
      if (coin.reference) {
        expect(coin.quote.symbol).toBe("USDC");
        expect(coin.nav?.source).toBe("chainlink");
      }
    }
    const feed = await get((await routes.feed()).GET, "/api/juno/feed?limit=10");
    expect(feed.status).toBe(200);
    expect(feed.body.deployed).toBe(true);
  });

  it("serves a coin page with history, holders and depth", async () => {
    const { GET } = await routes.coins();
    const list = await get(GET, "/api/juno/coins?limit=50");
    const traded = list.body.coins.find((coin: any) => coin.totalVolume > 0 && !coin.curve.graduated);
    if (!traded) return;
    const detail = await get((await routes.coin()).GET, `/api/juno/coins/${traded.address}`, { address: traded.address });
    expect(detail.status).toBe(200);
    expect(detail.body.coin.shape.points).toHaveLength(16);
    expect(detail.body.coin.priceHistory.length).toBeGreaterThan(0);
    expect(detail.body.launchTxHash).toMatch(/^0x[0-9a-f]{64}$/);
    const depth = await get((await routes.depth()).GET, `/api/juno/depth?token=${traded.address}&side=buy&impact=0.05`);
    expect(depth.status).toBe(200);
    expect(depth.body.points.length).toBeGreaterThan(0);
  });

  it("returns the stock references as a plain array", async () => {
    const stocks = await get((await routes.stocks()).GET, "/api/juno/stocks?chainId=421614");
    if (stocks.status === 503) return; // no feeds on this chain yet
    expect(Array.isArray(stocks.body)).toBe(true);
    for (const stock of stocks.body) expect(stock.price).toBeGreaterThan(0);
  });
});

describe.skipIf(!canSend)("Arbitrum Sepolia: trading, launching, graduating", () => {
  let post0: { address: string; pool: string };

  beforeAll(async () => {
    if (isLocal) {
      const anvil = createTestClient({ mode: "anvil", chain: arbitrumSepolia, transport: http(rpc) });
      await anvil.setBalance({ address: account.address, value: parseEther("50") });
    }
    const { GET } = await routes.coins();
    const list = await get(GET, "/api/juno/coins?limit=50&kind=post");
    post0 = list.body.coins.find((coin: any) => !coin.curve.graduated && coin.curve.progress < 0.5);
    expect(post0, "an open post curve to trade on").toBeTruthy();
  });

  it("buys a post: build → send → record → read back", async () => {
    const { POST } = await routes.swap();
    const build = await post(POST, "/api/juno/tx/swap", {
      chainId: SEPOLIA,
      curve: post0.pool,
      trader: wallet,
      side: "buy",
      amountIn: "0.0002",
    });
    expect(build.status, JSON.stringify(build.body)).toBe(200);
    expect(build.body.steps).toHaveLength(1);
    const hash = await send(build.body.steps);

    const recorded = await record(hash);
    expect(recorded.body).toMatchObject({ ok: true, status: "success", trades: 1 });

    const balance = await get((await routes.balance()).GET, `/api/juno/tx/balance?wallet=${wallet}&token=${post0.address}`);
    expect(balance.body.token).toBeGreaterThanOrEqual(build.body.quote.minimumAmountOut);

    const detail = await get((await routes.coin()).GET, `/api/juno/coins/${post0.address}`, { address: post0.address });
    expect(detail.body.activity.some((a: any) => a.txHash === hash.toLowerCase())).toBe(true);
    expect(detail.body.holders.some((h: any) => h.wallet === wallet)).toBe(true);
  });

  it("sells part of it back with no approve step", async () => {
    const { POST } = await routes.swap();
    const balance = await get((await routes.balance()).GET, `/api/juno/tx/balance?wallet=${wallet}&token=${post0.address}`);
    const build = await post(POST, "/api/juno/tx/swap", {
      chainId: SEPOLIA,
      curve: post0.pool,
      trader: wallet,
      side: "sell",
      amountIn: String(Math.floor(balance.body.token / 2)),
    });
    expect(build.status, JSON.stringify(build.body)).toBe(200);
    expect(build.body.steps.map((s: Step) => s.label)).toEqual(["Sell"]);
    const recorded = await record(await send(build.body.steps));
    expect(recorded.body.trades).toBe(1);

    const portfolio = await get((await routes.portfolio()).GET, `/api/juno/portfolio/${wallet}`, { wallet });
    const position = portfolio.body.positions.find((p: any) => p.token === post0.address);
    expect(position.balance).toBeGreaterThan(0);
    expect(position.trades).toHaveLength(2);
    expect(position.averageCost).toBeGreaterThan(0);
  });

  it("launches a post, records it, and lets its creator claim fees", async () => {
    const { POST } = await routes.launch();
    const symbol = `E2E${Date.now() % 10_000}`;
    const build = await post(POST, "/api/juno/tx/launch", {
      chainId: SEPOLIA,
      creator: wallet,
      name: "Integration launch",
      symbol,
      metadataUri: "ipfs://QmXgvs3sJshHPXgKryv1XwiV9cetPNqq94bcMcXccbYAaL",
      format: "post",
      preset: "thin-name",
      initialBuy: "0.0005",
    });
    expect(build.status, JSON.stringify(build.body)).toBe(200);
    const recorded = await record(await send(build.body.steps));
    expect(recorded.body.ok).toBe(true);
    expect(recorded.body.launched.token).toMatch(/^0x[0-9a-f]{40}$/);
    expect(recorded.body.trades).toBe(1); // the initial buy

    const token = recorded.body.launched.token;
    const detail = await get((await routes.coin()).GET, `/api/juno/coins/${token}`, { address: token });
    expect(detail.status).toBe(200);
    expect(detail.body.coin).toMatchObject({ symbol, curvePreset: "thin-name", format: "post" });
    expect(detail.body.coin.creator.wallet).toBe(wallet);
    expect(detail.body.coin.creatorFeesQuote).toBeGreaterThan(0);

    const claim = await post((await routes.claim()).POST, "/api/juno/tx/claim", {
      chainId: SEPOLIA,
      curve: recorded.body.launched.curve,
      creator: wallet,
    });
    expect(claim.status, JSON.stringify(claim.body)).toBe(200);
    const claimed = await record(await send(claim.body.steps));
    expect(claimed.body.claims).toBe(1);
  });

  it("refuses an out-of-band tracker buy, and the contract refuses it too", async () => {
    const usdc = deployed!.usdc;
    const { GET } = await routes.coins();
    const trackers = (await get(GET, "/api/juno/coins?limit=50&kind=stock&nav=1")).body.coins;
    const tracker = trackers.find((coin: any) => coin.nav?.marketOpen && !coin.curve.graduated);
    if (!usdc || !tracker) return;

    const mint = parseAbi(["function mint(address to, uint256 amount)"]);
    const minted = await signer.writeContract({ address: usdc, abi: mint, functionName: "mint", args: [account.address, parseUnits("10000", 6)] });
    await client.waitForTransactionReceipt({ hash: minted });

    // In band: a small buy goes through approve + buy.
    const small = await post((await routes.swap()).POST, "/api/juno/tx/swap", {
      chainId: SEPOLIA,
      curve: tracker.pool,
      trader: wallet,
      side: "buy",
      amountIn: "5",
    });
    expect(small.status, JSON.stringify(small.body)).toBe(200);
    expect(small.body.steps.map((s: Step) => s.label)).toEqual(["Approve USDC", "Buy"]);
    expect(small.body.quote).toMatchObject({ bandOk: true, marketOpen: true });
    expect(small.body.quote.bandBps).toBeGreaterThan(0);
    const smallRecord = await record(await send(small.body.steps));
    expect(smallRecord.body.trades).toBe(1);

    // Out of band: the server refuses in words...
    const big = await post((await routes.swap()).POST, "/api/juno/tx/swap", {
      chainId: SEPOLIA,
      curve: tracker.pool,
      trader: wallet,
      side: "buy",
      amountIn: "9500",
    });
    expect(big.status).toBe(400);
    expect(big.body.reason).toBe("OutsideBand");
    expect(big.body.error).toMatch(/above the stock/);

    // ...and the contract itself reverts with OutsideBand when sent anyway.
    const approve = parseAbi(["function approve(address spender, uint256 amount) returns (bool)"]);
    const approved = await signer.writeContract({
      address: usdc,
      abi: approve,
      functionName: "approve",
      args: [tracker.pool as Hex, parseUnits("9500", 6)],
    });
    await client.waitForTransactionReceipt({ hash: approved });
    const error = await client
      .simulateContract({
        account,
        address: tracker.pool as Hex,
        abi: junoCurveAbi,
        functionName: "buyWithQuote",
        args: [parseUnits("9500", 6), 0n, BigInt(Math.floor(Date.now() / 1000) + 600)],
      })
      .then(() => null)
      .catch((e: Error) => e);
    expect(error?.message).toMatch(/OutsideBand/);
  });

  it("graduates a full curve into Uniswap v3", async () => {
    const { GET } = await routes.coins();
    const full = (await get(GET, "/api/juno/coins?limit=50")).body.coins.find(
      (coin: any) => coin.curve.progress >= 1 && !coin.curve.graduated,
    );
    if (!full) return;
    const build = await post((await routes.graduate()).POST, "/api/juno/tx/graduate", {
      chainId: SEPOLIA,
      curve: full.pool,
      caller: wallet,
    });
    expect(build.status, JSON.stringify(build.body)).toBe(200);
    expect(Number(build.body.steps[0].gas)).toBeGreaterThanOrEqual(3_000_000);
    const recorded = await record(await send(build.body.steps));
    expect(recorded.body.graduations).toBe(1);
    const detail = await get((await routes.coin()).GET, `/api/juno/coins/${full.address}`, { address: full.address });
    expect(detail.body.coin.curve.graduated).toBe(true);
    expect(detail.body.coin.graduatedPool).toMatch(/^0x[0-9a-f]{40}$/);
  });

  it("ranks the wallet on the leaderboard", async () => {
    const board = await get((await routes.leaderboard()).GET, "/api/juno/leaderboard?limit=50");
    expect(board.status).toBe(200);
    expect(board.body.traders.some((t: any) => t.wallet === wallet)).toBe(true);
  });
});
