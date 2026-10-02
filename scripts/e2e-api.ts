/**
 * The API items of docs/TEST-PLAN.md (A, B, C, D), re-runnable: each prints
 * PASS or FAIL with what it saw, against the live API and the chain. Social
 * writes are signed by a fresh throwaway wallet; nothing here spends gas.
 *
 *   npx tsx e2e-api.ts
 */
import { createPublicClient, decodeFunctionData, erc20Abi, formatUnits, http, parseAbi } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { arbitrumSepolia } from "viem/chains";

import { junoCurveAbi } from "../config/abi";

const API = process.env.JUNO_API ?? "https://juno-arb-api.vercel.app";
const ORIGIN = "https://juno-arb-app.vercel.app";
const chain = createPublicClient({ chain: arbitrumSepolia, transport: http(process.env.ARB_SEPOLIA_RPC ?? "https://sepolia-rollup.arbitrum.io/rpc") });
const DEP = "0x39d73f1b3662a6120ebeafede5762809ba8f53b9";
const SMOKE = { token: "0x69f33cfa02073a1387dd25d0b45b25723acd82ce", curve: "0x7d4ceaa4e80aaa231f7b48d1cf8a7e84e340557b" } as const;
const TSLA = { token: "0x8b884153da62882e9f4484c7408e4ab3124f3fed", curve: "0x079fcf8ebd2542884d0dda3d75e410e97ba71d3c", feed: "0x293c9edbb475150d5f1b93e1f9a303c61f4ad685" } as const;
const GRAD = { token: "0xd2b8401420b2ef285ddea9e1c4b7ddf0c1c5e8ec", curve: "0x90e1b0000000000000000000000000000000000" } as const;
const USDC = "0x0afe4b5763813083d487b30215bdd21012c172ab";
const FACTORY = "0xbc89e74a36a9eff7b938211ea4b82650da3be87a";
const RICH = "0x980B62Da83eFf3D4576C647993b0c1D7faf17c73"; // Sepolia WETH: holds ETH, so a launch can be built for it (never signed)

let failures = 0;
function check(id: string, ok: boolean, detail: unknown) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${id}  ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 260)}`);
  if (!ok) failures++;
}
async function call<T = any>(method: string, path: string, body?: unknown, token?: string): Promise<{ status: number; body: T; headers: Headers }> {
  const r = await fetch(`${API}${path}`, {
    method,
    headers: { origin: ORIGIN, ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: (await r.json().catch(() => null)) as T, headers: r.headers };
}
const near = (a: number, b: number, rel = 1e-9) => Math.abs(a - b) <= Math.max(Math.abs(b) * rel, 1e-18);

// ---------------- A
const h = await call("GET", "/api/health");
const c421614 = h.body.chains.find((c: any) => c.chainId === 421614);
check("A1 health", h.status === 200 && h.body.ok && h.body.postgres.ok && h.body.mongo.ok && c421614.deployed && c421614.rpc.ok && h.body.faucet.ok === (h.body.faucet.balanceEth >= 0.03), { lag: c421614.indexer.lag, faucet: h.body.faucet });
const a2 = await call("GET", "/api/nope");
check("A2 unknown route", a2.status === 404 && a2.body.error === "No such API route", a2.body);
const pre = await fetch(`${API}/api/juno/likes`, { method: "OPTIONS", headers: { origin: ORIGIN, "access-control-request-headers": "authorization,content-type" } });
check("A3 CORS", h.headers.get("access-control-allow-origin") === "*" && (pre.headers.get("access-control-allow-headers") ?? "").includes("authorization"), pre.headers.get("access-control-allow-headers"));
check("A4 index needs the secret", (await call("POST", "/api/juno/index?chainId=421614")).status === 401, "401 without x-juno-index-secret");
const a5 = await call("GET", "/api/juno/index?chainId=421614");
// (A5's curve count is checked against the chain below, once the Launched events are read.)

// ---------------- B (vs chain)
const launched = await chain.getLogs({ address: FACTORY, fromBlock: 313703377n, event: parseAbi(["event Launched(address indexed curve, address indexed token, address indexed creator, uint8 preset, address quote, address feed, uint16 bandBps, uint256 supply, uint256 curveSupply, uint256 p0, uint256 capFp, address pool, string metadataURI)"])[0] });
check("A5 index status: every launch indexed", a5.status === 200 && typeof a5.body.lastBlock === "number" && a5.body.curves === launched.length, { curves: a5.body.curves, launches: launched.length });
/** Test launches taken off the listings with scripts/list-coin.ts: on-chain, but not listed. */
const CURATED = new Set<string>([SMOKE.token, GRAD.token]);
const listedLaunches = launched.filter((l) => !CURATED.has(l.args.token!.toLowerCase()));
const listedCurves = new Set(listedLaunches.map((l) => l.args.curve!.toLowerCase()));
const coins = await call("GET", "/api/juno/coins?chainId=421614&limit=100");
const priceOk = await Promise.all(
  coins.body.coins.filter((c: any) => !c.curve.graduated).map(async (c: any) => {
    const row = launched.find((l) => l.args.token!.toLowerCase() === c.address)!;
    const price = await chain.readContract({ address: row.args.curve!, abi: junoCurveAbi, functionName: "currentPrice" });
    return near(c.priceQuote, Number(formatUnits(price, c.quote.symbol === "USDC" ? 6 : 18)), 1e-6);
  }),
);
const launchedTokens = new Set(listedLaunches.map((l) => l.args.token!.toLowerCase()));
check("B1 coins = listed Launched events, prices = currentPrice()", coins.body.coins.length === listedLaunches.length && coins.body.coins.every((c: any) => launchedTokens.has(c.address)) && priceOk.every(Boolean), { coins: coins.body.coins.length, listedEvents: listedLaunches.length, priceOk });
const smoke = await call("GET", `/api/juno/coins/${SMOKE.token}`);
const tradeEvents = await chain.getContractEvents({ address: SMOKE.curve, abi: junoCurveAbi, eventName: "Trade", fromBlock: 313703377n });
const bal = await chain.readContract({ address: SMOKE.token, abi: erc20Abi, functionName: "balanceOf", args: [DEP] });
const holder = smoke.body.holders.find((x: any) => x.wallet === DEP);
check("B2 coin detail = chain", smoke.body.activity.length === tradeEvents.length && near(holder.balance, Number(formatUnits(bal, 18)), 1e-9) && smoke.body.tokenUrl.endsWith(SMOKE.token), { activity: smoke.body.activity.length, events: tradeEvents.length, holder: holder.balance });
check("B3 bad / unknown coin", (await call("GET", "/api/juno/coins/0xnope")).status === 400 && (await call("GET", "/api/juno/coins/0x000000000000000000000000000000000000dead")).status === 404, "400 / 404");
const feed = await call("GET", "/api/juno/feed?chainId=421614&limit=80");
const allTrades = (await Promise.all(listedLaunches.map((l) => chain.getContractEvents({ address: l.args.curve!, abi: junoCurveAbi, eventName: "Trade", fromBlock: 313703377n })))).flat();
const times = feed.body.items.map((i: any) => Date.parse(i.timestamp));
const feedTrades = feed.body.items.filter((i: any) => i.kind === "trade");
const feedPosts = feed.body.items.filter((i: any) => i.kind === "post");
const curatedTokens = CURATED;
const storedPosts = (await call("GET", "/api/juno/posts?chainId=421614&limit=80")).body.posts.filter((p: any) => !p.token || !curatedTokens.has(p.token));
const tradeIds = new Set(allTrades.map((e) => `${e.transactionHash}:${e.logIndex}`));
check(
  "B4 feed: trades = Trade events, posts = stored posts, newest first",
  feedTrades.length === allTrades.length && feedTrades.every((i: any) => tradeIds.has(i.id)) && feedPosts.length === storedPosts.length && feed.body.items.length === feedTrades.length + feedPosts.length && times.every((t: number, i: number) => i === 0 || t <= times[i - 1]),
  { trades: feedTrades.length, events: allTrades.length, posts: feedPosts.length, stored: storedPosts.length },
);
const st = await call("GET", "/api/juno/stocks?chainId=421614");
const [, answer, , updatedAt] = await chain.readContract({ address: TSLA.feed, abi: parseAbi(["function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)"]), functionName: "latestRoundData" });
const tsla = st.body.find((s: any) => s.symbol === "TSLA");
const age = Math.floor(Date.now() / 1000) - Number(updatedAt);
check("B5 stocks = feed", tsla.price === Number(answer) / 1e8 && Math.abs(tsla.ageSeconds - age) < 90 && tsla.marketOpen === age < 26 * 3600 && tsla.trackers.some((t: any) => t.symbol === "jTSLA"), { price: tsla.price, age: tsla.ageSeconds });
// A tracker still on its curve (one may have filled and moved to Uniswap).
const TRK = (() => {
  const t = st.body.flatMap((s: any) => s.trackers).find((x: any) => !x.curve.graduated);
  return { token: t.address as `0x${string}`, curve: t.pool as `0x${string}` };
})();
const depth = await call("GET", `/api/juno/depth?token=${TRK.token}&chainId=421614`);
const last = depth.body.points.at(-1);
const q = await chain.readContract({ address: TRK.curve, abi: junoCurveAbi, functionName: "quoteBuy", args: [BigInt(Math.round(last.amountIn * 1e6))] });
check("B6 depth = quoteBuy, refused sizes marked", near(last.amountOut, Number(formatUnits(q.tokensOut, 18)), 1e-6) && last.allowed === (q.bandOk && q.marketOpen) && depth.body.points.some((p: any) => p.allowed === false), { last: [last.amountIn, last.amountOut, last.allowed], chain: [Number(formatUnits(q.tokensOut, 18)), q.bandOk] });
const lb = await call("GET", "/api/juno/leaderboard?chainId=421614");
const ranked = lb.body.traders.reduce((n: number, t: any) => n + t.trades, 0);
check("B7 leaderboard: every trade on a listed coin is counted once", ranked === allTrades.length, { ranked, events: allTrades.length });
const pf = await call("GET", `/api/juno/portfolio/${DEP}?chainId=421614`);
const pfOk = await Promise.all(pf.body.positions.map(async (p: any) => near(p.balance, Number(formatUnits(await chain.readContract({ address: p.token ?? p.address ?? p.coin?.address, abi: erc20Abi, functionName: "balanceOf", args: [DEP] }), 18)), 1e-9)));
check("B8 portfolio = balanceOf", pfOk.length >= 1 && pfOk.every(Boolean), pfOk);
const tb = await call("GET", `/api/juno/tx/balance?wallet=${DEP}&chainId=421614`);
const ethBal = await chain.getBalance({ address: DEP });
const usdcBal = await chain.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [DEP] });
check("B9 balances = chain", near(tb.body.eth, Number(formatUnits(ethBal, 18))) && tb.body.usdc === Number(formatUnits(usdcBal, 6)), tb.body);
check("B10 posts list / unknown id", (await call("GET", "/api/juno/posts?chainId=421614")).status === 200 && (await call("GET", "/api/juno/posts/nope")).status === 404, "200 / 404");
const b11 = await Promise.all([
  call("GET", `/api/juno/likes?coins=${SMOKE.token}`), call("GET", `/api/juno/comments?coin=${SMOKE.token}`), call("GET", `/api/juno/profiles?wallets=${DEP}`),
  call("GET", `/api/juno/follow?wallet=${DEP}`), call("GET", `/api/juno/saved?wallet=${DEP}&baseMint=${SMOKE.token}`), call("GET", `/api/juno/watchlist?wallet=${DEP}`), call("GET", `/api/juno/plans?wallet=${DEP}`),
  call("GET", "/api/juno/likes?coins=x"), call("GET", "/api/juno/profiles?wallets=bad"), call("GET", "/api/juno/comments?coin=bad"), call("GET", "/api/juno/watchlist?wallet=bad"),
]);
check("B11 social reads; bad addresses 400", b11.slice(0, 7).every((r) => r.status === 200) && b11.slice(7).every((r) => r.status === 400), b11.map((r) => r.status));
check("B12 ipfs: bad cid 400 (with CORS)", await fetch(`${API}/api/ipfs/not-a-cid`, { headers: { origin: ORIGIN } }).then((r) => r.status === 400 && r.headers.get("access-control-allow-origin") === "*"), "400");
const fa = await call("GET", "/api/juno/faucet?chainId=421614");
check("B13 faucet status = chain", near(fa.body.balanceEth, Number(formatUnits(await chain.getBalance({ address: fa.body.address }), 18))), fa.body);

// ---------------- C
const curveCalls = parseAbi(["function buy(uint256,uint256) payable", "function sell(uint256,uint256,uint256)", "function buyWithQuote(uint256,uint256,uint256)"]);
const c1 = await call("POST", "/api/juno/tx/swap", { chainId: 421614, curve: SMOKE.curve, trader: DEP, side: "buy", amountIn: "0.000005" });
const c1d = c1.body.steps && decodeFunctionData({ abi: curveCalls, data: c1.body.steps[0].data });
check("C1 ETH buy calldata", c1.status === 200 && c1d?.functionName === "buy" && c1.body.steps[0].value === "5000000000000" && near(Number(formatUnits(c1d.args[0] as bigint, 18)), c1.body.quote.amountOut * 0.99, 1e-6), c1.body.error ?? "buy(minOut, deadline)");
const c2 = await call("POST", "/api/juno/tx/swap", { chainId: 421614, curve: SMOKE.curve, trader: DEP, side: "sell", amountIn: "1000" });
check("C2 sell calldata, no approve", c2.status === 200 && c2.body.steps.length === 1 && decodeFunctionData({ abi: curveCalls, data: c2.body.steps[0].data }).functionName === "sell", c2.body.error ?? "sell");
const c3 = await call("POST", "/api/juno/tx/swap", { chainId: 421614, curve: TRK.curve, trader: DEP, side: "buy", amountIn: "10" });
// Approve first only when the wallet's USDC allowance for this curve is short.
const allowance3 = await chain.readContract({ address: USDC, abi: erc20Abi, functionName: "allowance", args: [DEP, TRK.curve] });
const expected3 = allowance3 >= 10_000_000n ? "Buy" : "Approve USDC,Buy";
check("C3 USDC buy: approve only when the allowance is short, then buyWithQuote", c3.status === 200 && c3.body.steps.map((s: any) => s.label).join() === expected3, { allowance: String(allowance3), steps: c3.body.error ?? c3.body.steps.map((s: any) => s.label) });
const c4ok = await call("POST", "/api/juno/tx/swap", { chainId: 421614, curve: TRK.curve, side: "buy", amountIn: "500", quoteOnly: true });
const c4no = await call("POST", "/api/juno/tx/swap", { chainId: 421614, curve: TRK.curve, side: "buy", amountIn: "9500", quoteOnly: true });
check("C4 visitor quote; band refusal as an answer", c4ok.status === 200 && c4ok.body.quote.amountOut > 1 && c4no.status === 200 && c4no.body.refusal?.reason === "OutsideBand", { ok: c4ok.body.quote?.amountOut, refusal: c4no.body.refusal });
const c4signed = await call("POST", "/api/juno/tx/swap", { chainId: 421614, curve: TRK.curve, trader: DEP, side: "buy", amountIn: "9500" });
check("C4 signed-in band refusal stays a 400", c4signed.status === 400 && c4signed.body.reason === "OutsideBand", c4signed.body);
const c5a = await call("POST", "/api/juno/tx/claim", { chainId: 421614, curve: SMOKE.curve, owner: "0x000000000000000000000000000000000000dEaD" });
const c5b = await call("POST", "/api/juno/tx/claim", { chainId: 421614, curve: SMOKE.curve, owner: DEP });
check("C5 claim: not creator 403; creator with fees gets a step", c5a.status === 403 && (c5b.status === 200 ? c5b.body.steps[0].label === "Claim fees" : c5b.body.error === "Nothing to claim yet." || /Not enough ETH/.test(c5b.body.error)), [c5a.status, c5b.status, c5b.body.error ?? c5b.body.amount]);
const c6a = await call("POST", "/api/juno/tx/graduate", { chainId: 421614, curve: launched.find((l) => l.args.token!.toLowerCase() === GRAD.token)!.args.curve, trader: DEP });
const c6b = await call("POST", "/api/juno/tx/graduate", { chainId: 421614, curve: SMOKE.curve, trader: DEP });
check("C6 graduate: graduated / not full", c6a.body.error === "This market moved to Uniswap." && /not full/.test(c6b.body.error), [c6a.body.error, c6b.body.error]);
const c7 = await call("POST", "/api/juno/tx/launch", { chainId: 421614, creator: RICH, name: "Plan Check", symbol: "PLAN", metadataUri: "ipfs://QmZb8GpGsdzB7w8bn5N1rSf25cBKerxc8hS3NAWtxnCBiy", format: "post", preset: "content" });
check("C7 launch builds factory.launch", c7.status === 200 && c7.body.steps[0].to.toLowerCase() === FACTORY && c7.body.steps[0].data.startsWith("0x"), c7.body.error ?? c7.body.steps[0].label);
const c8 = await call("POST", "/api/juno/tx/record", { chainId: 421614, txHash: "0xffc4fdea103e470126b9ff5e6eca25711ea8be6558ff89f4c4fcb6988143c370" });
const c8n = await call("POST", "/api/juno/tx/record", { chainId: 421614, txHash: "0xc44830c099b6fa26d271d98f0d51302deb52a5141d877bbd81ff080543112871" });
check("C8 record: real trade / no Juno logs / bad hash", c8.body.trades === 1 && c8n.body.trades === 0 && (await call("POST", "/api/juno/tx/record", { chainId: 421614, txHash: "0x12" })).status === 400, [c8.body.trades, c8n.body.trades]);

// ---------------- D (fresh wallet, real signatures)
const me = privateKeyToAccount(generatePrivateKey());
const W = me.address.toLowerCase();
const issued = new Date().toISOString();
const sess = await call("POST", "/api/juno/session", { chainId: 421614, wallet: W, issuedAt: issued, signature: await me.signMessage({ message: `Juno session\nWallet: ${W}\nIssued: ${issued}` }) });
const T = sess.body.token;
const forged = await call("POST", "/api/juno/session", { chainId: 421614, wallet: DEP, issuedAt: issued, signature: await me.signMessage({ message: `Juno session\nWallet: ${DEP}\nIssued: ${issued}` }) });
check("D0 session: signed opens, forged 401", sess.status === 201 && forged.status === 401, [sess.status, forged.status]);
const like1 = await call("POST", "/api/juno/likes", { chainId: 421614, coin: SMOKE.token, wallet: W, like: true }, T);
const like2 = await call("POST", "/api/juno/likes", { chainId: 421614, coin: SMOKE.token, wallet: W, like: true }, T);
const unlike = await call("POST", "/api/juno/likes", { chainId: 421614, coin: SMOKE.token, wallet: W, like: false }, T);
check("D3 like / idempotent / unlike / spoof 403 / anon 401", like1.body.liked && like2.body.likes === like1.body.likes && unlike.body.likes === like1.body.likes - 1 && (await call("POST", "/api/juno/likes", { chainId: 421614, coin: SMOKE.token, wallet: DEP, like: true }, T)).status === 403 && (await call("POST", "/api/juno/likes", { chainId: 421614, coin: SMOKE.token, wallet: W, like: true })).status === 401, [like1.body.likes, unlike.body.likes]);
check("D2 comment spoof 403 / anon 401 / empty 400", (await call("POST", "/api/juno/comments", { chainId: 421614, coin: SMOKE.token, wallet: DEP, body: "x" }, T)).status === 403 && (await call("POST", "/api/juno/comments", { chainId: 421614, coin: SMOKE.token, wallet: W, body: "x" })).status === 401 && (await call("POST", "/api/juno/comments", { chainId: 421614, coin: SMOKE.token, wallet: W, body: " " }, T)).status === 400, "403/401/400");
const f1 = await call("POST", "/api/juno/follow", { chainId: 421614, follower: W, target: DEP, follow: true }, T);
const f0 = await call("POST", "/api/juno/follow", { chainId: 421614, follower: W, target: DEP, follow: false }, T);
check("D4 follow / unfollow / spoof 403", f1.body.isFollowing && !f0.body.isFollowing && f0.body.followers === f1.body.followers - 1 && (await call("POST", "/api/juno/follow", { chainId: 421614, follower: DEP, target: W, follow: true }, T)).status === 403, [f1.body.followers, f0.body.followers]);
const w1 = await call("POST", "/api/juno/watchlist", { chainId: 421614, wallet: W, baseMint: SMOKE.token, watch: true }, T);
const wl = await call("GET", `/api/juno/watchlist?wallet=${W}`);
const w0 = await call("POST", "/api/juno/watchlist", { chainId: 421614, wallet: W, baseMint: SMOKE.token, watch: false }, T);
check("D5 watch / list / unwatch / spoof 403", w1.body.watching && wl.body.items.length === 1 && !w0.body.watching && (await call("POST", "/api/juno/watchlist", { chainId: 421614, wallet: DEP, baseMint: SMOKE.token, watch: true }, T)).status === 403, [wl.body.items.length]);
const p1 = await call("POST", "/api/juno/plans", { chainId: 421614, wallet: W, baseMint: SMOKE.token, amount: 0.001, cadence: "weekly" }, T);
const pp = await call("PATCH", "/api/juno/plans", { id: p1.body.id, active: false }, T);
const pAnon = await call("PATCH", "/api/juno/plans", { id: p1.body.id, active: true });
const pDel = await fetch(`${API}/api/juno/plans?id=${p1.body.id}`, { method: "DELETE", headers: { authorization: `Bearer ${T}` } });
check("D6 plan create / pause / anon 401 / delete", p1.status === 201 && pp.body.active === false && pAnon.status === 401 && pDel.status === 200 && (await call("GET", `/api/juno/plans?wallet=${W}`)).body.plans.length === 0, [p1.status, pp.status, pAnon.status, pDel.status]);
check("D7 post spoof 403 / anon 401", (await call("POST", "/api/juno/posts", { chainId: 421614, authorWallet: DEP, body: "x" }, T)).status === 403 && (await call("POST", "/api/juno/posts", { chainId: 421614, authorWallet: W, body: "x" })).status === 401, "403/401");
const form = new FormData();
form.append("file", new File([new Uint8Array([137, 80, 78, 71])], "x.png", { type: "image/png" }));
check("D8 upload / metadata anonymous 401", (await fetch(`${API}/api/juno/upload`, { method: "POST", body: form })).status === 401 && (await call("POST", "/api/juno/metadata", { name: "x", symbol: "X", curvePreset: "content" })).status === 401, "401/401");
const nIssued = new Date().toISOString();
const other = privateKeyToAccount(generatePrivateKey());
const badName = await call("POST", "/api/juno/profiles", { chainId: 421614, wallet: W, name: "hijacked", issuedAt: nIssued, signature: await other.signMessage({ message: `Juno name: hijacked\nWallet: ${W}\nIssued: ${nIssued}` }) });
check("D1 name: wrong signer 401", badName.status === 401 && badName.body.reason === "BadSignature", badName.body);

console.log(failures ? `\n${failures} FAILED` : "\nall API items pass");
process.exitCode = failures ? 1 : 0;
