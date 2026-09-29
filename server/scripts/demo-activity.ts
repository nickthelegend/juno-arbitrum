/**
 * Demo data for Arbitrum Sepolia, through the production API (plan phase 6).
 *
 * - five `demo_` wallets, funded from the faucet key, each with a claimed
 *   (EIP-191 signed) name;
 * - six posts and reels launched from the Pexels footage already pinned to
 *   IPFS (metadata → tx/launch → send → tx/record);
 * - three stock trackers (TSLA, NVDA, AAPL) against the Chainlink feeds, with
 *   the band defaults from `lib/juno/trackers.ts`;
 * - ~30 buys and sells across all of them, some with notes;
 * - one small content curve filled and graduated into Uniswap v3;
 * - likes, comments, follows and a few text posts.
 *
 * Every trade goes the way the phone's does: the server builds and simulates
 * the steps, the demo wallet signs and sends them, the server records the
 * receipt. Nothing is written to the database directly.
 *
 * Idempotent: progress is kept per chain and factory in
 * `.juno/demo-arb/progress-<chainId>-<factory>.json`, keys in
 * `.juno/demo-arb/<name>.key` (repo root, gitignored).
 *
 *   npm run demo -- [--api http://localhost:3100] [--funder faucet|deployer] [--fund 0.012]
 *
 * On a local anvil fork (`source scripts/fork-env.sh`) wallets are funded with
 * `anvil_setBalance` instead.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  createTestClient,
  createWalletClient,
  formatEther,
  http,
  parseAbi,
  parseEther,
  parseUnits,
  type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";

import { junoFactoryAbi } from "@config/abi";
import { aggregatorAbi } from "../lib/juno/chainlink";
import { deployment, publicClient, rpcUrls, SEPOLIA, viemChain } from "../lib/juno/chains";
import { nameMessage } from "../lib/juno/names";
import { pinJson } from "../lib/juno/pinata";
import { sessionMessage } from "../lib/juno/session";
import { trackerLaunchParams } from "../lib/juno/trackers";
import { launchP0 } from "../lib/juno/tx";

const arg = (flag: string, fallback: string) =>
  process.argv.includes(flag) ? process.argv[process.argv.indexOf(flag) + 1] : fallback;

const API = arg("--api", process.env.JUNO_API ?? "http://localhost:3100").replace(/\/$/, "");
const FUNDER = arg("--funder", "faucet");
const FUND_ETH = parseEther(arg("--fund", "0.012"));
const CHAIN = SEPOLIA;

const deployed = deployment(CHAIN);
if (!deployed) throw new Error("Juno is not deployed on Arbitrum Sepolia (config/addresses.ts has no factory).");
const rpc = rpcUrls(CHAIN)[0];
const isLocal = /127\.0\.0\.1|localhost/.test(rpc);
const client = publicClient(CHAIN);

/* ------------------------------------------------------------------ */
/* The plan                                                            */
/* ------------------------------------------------------------------ */

const WALLETS = ["demo_ana", "demo_kai", "demo_rio", "demo_lena", "demo_maya"] as const;
type Name = (typeof WALLETS)[number];

type PostPlan = {
  key: string;
  creator: Name;
  name: string;
  symbol: string;
  description: string;
  media: string;
  poster?: string;
  mime: string;
  width: number;
  height: number;
  format: "post" | "reel";
  preset: "content" | "thin-name" | "ipo-book";
};

/** Free-licence Pexels footage and photos, already pinned to IPFS. */
const POSTS: PostPlan[] = [
  { key: "FALLS", creator: "demo_ana", name: "The Falls", symbol: "FALLS", description: "First light.", media: "ipfs://QmdPaKD9DuWJ9b2DSPoSQFLaBvKGPcpMs4Lq5XUVTPPd4t", mime: "image/jpeg", width: 3000, height: 2002, format: "post", preset: "content" },
  { key: "TIDE", creator: "demo_kai", name: "Last Light, Low Tide", symbol: "TIDE", description: "Dusk at the beach. One surfer still out.", media: "ipfs://QmdXCVRYkZnBDJuPW4KyAQgdbcBJuezY5aW3wsosYtkxhe", poster: "ipfs://QmUnwbLu1e8gqvqMjuytmcbKdjTAqn55az9ZUcmh1PdW8J", mime: "video/mp4", width: 720, height: 1280, format: "reel", preset: "content" },
  { key: "SURF", creator: "demo_rio", name: "Board Check", symbol: "SURF", description: "Wax on, then paddle out.", media: "ipfs://QmNT3Cq1za3zNCjYLmtxkyD5RYXknMftBXUiTQZESoa1Bt", poster: "ipfs://QmaLJFi1Z3zVqAPZhc6rHy1nxGrKrdzM7yJaUi4tXcvbpi", mime: "video/mp4", width: 720, height: 1280, format: "reel", preset: "ipo-book" },
  { key: "KICK", creator: "demo_maya", name: "Park Session", symbol: "KICK", description: "Kickflip practice before the rain.", media: "ipfs://Qmb5k2eTcqvu9XJZfEN2wXsgj2Ddq9u5qNjBJ9jRB7pags", poster: "ipfs://QmeZ89H8eJwqrdaRgH1FWrQebJEk9F6vk4SGPCrf4e2K7u", mime: "video/mp4", width: 720, height: 1280, format: "reel", preset: "content" },
  { key: "NEON", creator: "demo_lena", name: "City After Rain", symbol: "NEON", description: "Neon, wet streets, 2am.", media: "ipfs://QmYX6QBEyzHWm5cB4zA97oT5GhBVvnvgDNn3tf9d6r7AmK", poster: "ipfs://QmY4VuQhFWeReFPrfUAJX3LXASnQHjb7UBAteZ4m4GDcXc", mime: "video/mp4", width: 720, height: 1280, format: "reel", preset: "content" },
  { key: "BLOOM", creator: "demo_lena", name: "Wild Bloom", symbol: "BLOOM", description: "Spring, all at once.", media: "ipfs://QmZsvmG3ftAb3dHMMwhLcMzjiGgSGQSLWY4aFEbLHcDPQB", mime: "image/jpeg", width: 4032, height: 3024, format: "post", preset: "thin-name" },
];

const TRACKERS = [
  { key: "TSLA", name: "Tesla Tracker", description: "Tracks Tesla (TSLA) through Chainlink. The contract refuses any buy that would lift it more than 1% above the stock, and pauses buys when the market is closed." },
  { key: "NVDA", name: "NVIDIA Tracker", description: "Tracks NVIDIA (NVDA) through Chainlink, held within 1% of the stock by the contract." },
  { key: "AAPL", name: "Apple Tracker", description: "Tracks Apple (AAPL) through Chainlink, held within 1% of the stock by the contract." },
] as const;

type Trade = { who: Name; coin: string; side: "buy" | "sell"; amount: number; note?: string };

/** ETH for posts, USDC for trackers; a sell's amount is the share of what that wallet holds. */
const TRADES: Trade[] = [
  { who: "demo_kai", coin: "FALLS", side: "buy", amount: 0.0012, note: "Early on this one." },
  { who: "demo_rio", coin: "FALLS", side: "buy", amount: 0.0008 },
  { who: "demo_lena", coin: "TIDE", side: "buy", amount: 0.001, note: "That light." },
  { who: "demo_maya", coin: "TIDE", side: "buy", amount: 0.0006 },
  { who: "demo_ana", coin: "SURF", side: "buy", amount: 0.0015 },
  { who: "demo_kai", coin: "KICK", side: "buy", amount: 0.0009, note: "That landing though." },
  { who: "demo_rio", coin: "NEON", side: "buy", amount: 0.0011 },
  { who: "demo_ana", coin: "BLOOM", side: "buy", amount: 0.0007 },
  { who: "demo_maya", coin: "TSLA", side: "buy", amount: 60, note: "Tracking the stock nicely." },
  { who: "demo_kai", coin: "NVDA", side: "buy", amount: 45 },
  { who: "demo_lena", coin: "AAPL", side: "buy", amount: 40 },
  { who: "demo_rio", coin: "FALLS", side: "sell", amount: 0.5 },
  { who: "demo_ana", coin: "TIDE", side: "buy", amount: 0.0005 },
  { who: "demo_lena", coin: "KICK", side: "buy", amount: 0.0006 },
  { who: "demo_maya", coin: "NEON", side: "buy", amount: 0.0008, note: "Saving this one." },
  { who: "demo_rio", coin: "TSLA", side: "buy", amount: 35 },
  { who: "demo_ana", coin: "NVDA", side: "buy", amount: 25 },
  { who: "demo_kai", coin: "TIDE", side: "buy", amount: 0.0007 },
  { who: "demo_lena", coin: "SURF", side: "buy", amount: 0.0006 },
  { who: "demo_maya", coin: "BLOOM", side: "buy", amount: 0.0005 },
  { who: "demo_kai", coin: "KICK", side: "sell", amount: 0.4 },
  { who: "demo_ana", coin: "AAPL", side: "buy", amount: 30 },
  { who: "demo_rio", coin: "KICK", side: "buy", amount: 0.0004 },
  { who: "demo_lena", coin: "FALLS", side: "buy", amount: 0.0006 },
  { who: "demo_maya", coin: "TSLA", side: "sell", amount: 0.3 },
  { who: "demo_kai", coin: "NEON", side: "buy", amount: 0.0005 },
  { who: "demo_ana", coin: "SURF", side: "sell", amount: 0.25, note: "Took a little off." },
  { who: "demo_rio", coin: "BLOOM", side: "buy", amount: 0.0004 },
];

const COMMENTS: Array<{ who: Name; coin: string; body: string }> = [
  { who: "demo_rio", coin: "TIDE", body: "The colour at 0:04 is unreal." },
  { who: "demo_ana", coin: "KICK", body: "Clean." },
  { who: "demo_maya", coin: "FALLS", body: "Where is this?" },
  { who: "demo_kai", coin: "TSLA", body: "Band held on the dip. Nice." },
];

/* ------------------------------------------------------------------ */
/* Keys and progress                                                   */
/* ------------------------------------------------------------------ */

const HOME = path.resolve(process.cwd(), "..", ".juno", "demo-arb");
mkdirSync(HOME, { recursive: true });

/** Every demo account by lowercase address, so a write can sign its wallet's session. */
const signers = new Map<string, PrivateKeyAccount>();

function keyFor(name: string): PrivateKeyAccount {
  const file = path.join(HOME, `${name}.key`);
  if (!existsSync(file)) writeFileSync(file, generatePrivateKey(), { mode: 0o600 });
  const account = privateKeyToAccount(readFileSync(file, "utf8").trim() as Hex);
  signers.set(account.address.toLowerCase(), account);
  return account;
}

type Progress = {
  names: Record<string, boolean>;
  funded: Record<string, boolean>;
  coins: Record<string, { token: string; curve: string }>;
  trades: Record<string, string>;
  comments: Record<string, boolean>;
  social: Record<string, boolean>;
  graduated?: string;
};
const PROGRESS = path.join(HOME, `progress-${CHAIN}-${deployed.factory}.json`);
const progress: Progress = existsSync(PROGRESS)
  ? JSON.parse(readFileSync(PROGRESS, "utf8"))
  : { names: {}, funded: {}, coins: {}, trades: {}, comments: {}, social: {} };
const save = () => writeFileSync(PROGRESS, JSON.stringify(progress, null, 2));

/* ------------------------------------------------------------------ */
/* Plumbing                                                            */
/* ------------------------------------------------------------------ */

/** Social writes and pins carry the writing wallet's session, as the app's do. */
const SESSION_ROUTES = ["/api/juno/comments", "/api/juno/likes", "/api/juno/follow", "/api/juno/posts", "/api/juno/metadata", "/api/juno/watchlist", "/api/juno/plans"];
const sessions = new Map<string, string>();

async function sessionFor(account: PrivateKeyAccount): Promise<string> {
  const wallet = account.address.toLowerCase();
  const cached = sessions.get(wallet);
  if (cached) return cached;
  const issuedAt = new Date().toISOString();
  const signature = await account.signMessage({ message: sessionMessage(wallet, issuedAt) });
  const response = await fetch(`${API}/api/juno/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chainId: CHAIN, wallet, issuedAt, signature }),
  });
  const json = (await response.json().catch(() => ({}))) as { token?: string; error?: string };
  if (!response.ok || !json.token) throw new Error(`session for ${wallet}: ${json.error ?? response.status}`);
  sessions.set(wallet, json.token);
  return json.token;
}

async function api<T = any>(route: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (body !== undefined && SESSION_ROUTES.includes(route)) {
    const fields = body as Record<string, unknown>;
    const writer = String(fields.wallet ?? fields.follower ?? fields.authorWallet ?? fields.creator ?? "").toLowerCase();
    const account = signers.get(writer);
    if (!account) throw new Error(`${route}: no demo key for ${writer || "(no wallet)"}`);
    headers.authorization = `Bearer ${await sessionFor(account)}`;
  }
  const response = await fetch(`${API}${route}`, {
    method: body === undefined ? "GET" : "POST",
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(`${route}: ${json.error ?? response.status}`);
  return json;
}

const walletOf = (account: PrivateKeyAccount) =>
  createWalletClient({ account, chain: viemChain(CHAIN), transport: http(rpc) });

type Step = { label: string; to: Hex; data: Hex; value: string; gas: string };

async function sendSteps(account: PrivateKeyAccount, steps: Step[]): Promise<Hex> {
  const wallet = walletOf(account);
  let last: Hex | null = null;
  for (const step of steps) {
    const hash = await wallet.sendTransaction({ to: step.to, data: step.data, value: BigInt(step.value), gas: BigInt(step.gas) });
    const receipt = await client.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`${step.label} reverted: ${hash}`);
    last = hash;
  }
  return last!;
}

const record = (hash: Hex) => api<{ launched?: { token: string; curve: string }; trades: number }>("/api/juno/tx/record", { chainId: CHAIN, txHash: hash });

function funderAccount(): PrivateKeyAccount {
  const key = FUNDER === "deployer" ? process.env.DEPLOYER_PRIVATE_KEY : process.env.FAUCET_PRIVATE_KEY;
  if (!key) throw new Error(`${FUNDER === "deployer" ? "DEPLOYER" : "FAUCET"}_PRIVATE_KEY is not set`);
  return privateKeyToAccount((key.startsWith("0x") ? key : `0x${key}`) as Hex);
}

const testUsdc = parseAbi(["function mint(address to, uint256 amount)"]);

/* ------------------------------------------------------------------ */
/* Run                                                                 */
/* ------------------------------------------------------------------ */

async function fund(accounts: Record<Name, PrivateKeyAccount>) {
  const anvil = isLocal ? createTestClient({ mode: "anvil", chain: viemChain(CHAIN), transport: http(rpc) }) : null;
  const funder = anvil ? null : funderAccount();
  for (const name of WALLETS) {
    const account = accounts[name];
    const balance = await client.getBalance({ address: account.address });
    if (balance < (anvil ? parseEther("0.5") : FUND_ETH / 2n)) {
      // Anvil's fork charges ~1 gwei (Sepolia ~0.03), and a launch is ~6M gas.
      if (anvil) await anvil.setBalance({ address: account.address, value: parseEther("1") });
      else {
        const hash = await walletOf(funder!).sendTransaction({ to: account.address, value: FUND_ETH - balance });
        await client.waitForTransactionReceipt({ hash });
      }
      console.log(`  funded ${name} to ${anvil ? "1" : formatEther(FUND_ETH)} ETH`);
    }
    if (deployed!.usdc && !progress.funded[name]) {
      const hash = await walletOf(account).writeContract({ address: deployed!.usdc, abi: testUsdc, functionName: "mint", args: [account.address, parseUnits("500", 6)] });
      await client.waitForTransactionReceipt({ hash });
      progress.funded[name] = true;
      save();
      console.log(`  minted 500 test USDC to ${name}`);
    }
  }
}

async function claimNames(accounts: Record<Name, PrivateKeyAccount>) {
  for (const name of WALLETS) {
    if (progress.names[name]) continue;
    const account = accounts[name];
    const issuedAt = new Date().toISOString();
    const signature = await account.signMessage({ message: nameMessage(account.address, name, issuedAt) });
    await api("/api/juno/profiles", { chainId: CHAIN, wallet: account.address, name, issuedAt, signature })
      .then(() => {
        progress.names[name] = true;
        save();
        console.log(`  named ${name}`);
      })
      .catch((error: Error) => console.log(`  name ${name}: ${error.message}`));
  }
}

async function launchPosts(accounts: Record<Name, PrivateKeyAccount>) {
  for (const post of POSTS) {
    if (progress.coins[post.key]) continue;
    const creator = accounts[post.creator];
    const pinned = await api<{ uri: string }>("/api/juno/metadata", {
      name: post.name,
      symbol: post.symbol,
      description: post.description,
      mediaUrl: post.media,
      mimeType: post.mime,
      posterUrl: post.poster,
      format: post.format,
      creator: creator.address,
      width: post.width,
      height: post.height,
      curvePreset: post.preset,
    });
    const build = await api<{ steps: Step[] }>("/api/juno/tx/launch", {
      chainId: CHAIN,
      creator: creator.address,
      name: post.name,
      symbol: post.symbol,
      metadataUri: pinned.uri,
      format: post.format,
      preset: post.preset,
      initialBuy: "0.0003",
    });
    const recorded = await record(await sendSteps(creator, build.steps));
    if (!recorded.launched) throw new Error(`${post.key}: launch not recorded`);
    progress.coins[post.key] = recorded.launched;
    save();
    console.log(`  launched ${post.key} (${post.format}) by ${post.creator}: ${recorded.launched.token}`);
  }
}

async function launchTrackers(launcher: PrivateKeyAccount) {
  for (const tracker of TRACKERS) {
    if (progress.coins[tracker.key]) continue;
    const feed = deployed!.feeds[tracker.key];
    if (!feed || !deployed!.usdc) {
      console.log(`  ${tracker.key}: no feed or USDC on this chain, skipped`);
      continue;
    }
    const [decimals, round] = await Promise.all([
      client.readContract({ address: feed, abi: aggregatorAbi, functionName: "decimals" }),
      client.readContract({ address: feed, abi: aggregatorAbi, functionName: "latestRoundData" }),
    ]);
    const pinned = await pinJson(
      {
        name: tracker.name,
        symbol: `j${tracker.key}`,
        description: tracker.description,
        image: "",
        external_url: "",
        properties: { format: "post", creator: launcher.address.toLowerCase(), launchpad: "Juno", reference: { source: "chainlink", symbol: tracker.key, feed } },
      },
      `juno-j${tracker.key}-metadata`,
    );
    const params = trackerLaunchParams({
      symbol: tracker.key,
      name: tracker.name,
      metadataURI: pinned.uri,
      quote: deployed!.usdc,
      feed,
      answer: round[1],
      feedDecimals: Number(decimals),
    });
    const hash = await walletOf(launcher).writeContract({ address: deployed!.factory, abi: junoFactoryAbi, functionName: "launchTracker", args: [params] });
    await client.waitForTransactionReceipt({ hash });
    const recorded = await record(hash);
    if (!recorded.launched) throw new Error(`${tracker.key}: launch not recorded`);
    progress.coins[tracker.key] = recorded.launched;
    save();
    console.log(`  launched tracker j${tracker.key}: ${recorded.launched.token}`);
  }
}

async function trade(accounts: Record<Name, PrivateKeyAccount>) {
  for (const [index, step] of TRADES.entries()) {
    const id = `${index}:${step.who}:${step.coin}:${step.side}`;
    if (progress.trades[id]) continue;
    const coin = progress.coins[step.coin];
    if (!coin) continue;
    const account = accounts[step.who];
    try {
      let amountIn = String(step.amount);
      if (step.side === "sell") {
        const balance = await api<{ token: number | null }>(`/api/juno/tx/balance?chainId=${CHAIN}&wallet=${account.address}&token=${coin.token}`);
        const held = balance.token ?? 0;
        if (!(held > 0)) continue;
        amountIn = (held * step.amount).toFixed(6);
      }
      const build = await api<{ steps: Step[] }>("/api/juno/tx/swap", {
        chainId: CHAIN,
        curve: coin.curve,
        trader: account.address,
        side: step.side,
        amountIn,
        slippageBps: 300,
      });
      const hash = await sendSteps(account, build.steps);
      await record(hash);
      progress.trades[id] = hash;
      save();
      console.log(`  ${step.who} ${step.side} ${amountIn} ${step.coin}  ${hash}`);
      if (step.note) {
        await api("/api/juno/comments", { chainId: CHAIN, coin: coin.token, wallet: account.address, body: step.note, side: step.side, txHash: hash }).catch(
          (error: Error) => console.log(`  note: ${error.message}`),
        );
      }
    } catch (error) {
      console.log(`  ${step.who} ${step.side} ${step.coin} skipped: ${(error as Error).message}`);
    }
  }
}

/** A deliberately small content curve, launched by the script and filled, so a real graduation exists. */
async function graduate(accounts: Record<Name, PrivateKeyAccount>) {
  if (progress.graduated) return;
  const creator = accounts.demo_kai;
  if (!progress.coins.GRAD) {
    const pinned = await api<{ uri: string }>("/api/juno/metadata", {
      name: "Graduation Day",
      symbol: "GRAD",
      description: "A small curve launched to fill and graduate into Uniswap v3, end to end.",
      mediaUrl: "ipfs://QmdPaKD9DuWJ9b2DSPoSQFLaBvKGPcpMs4Lq5XUVTPPd4t",
      mimeType: "image/jpeg",
      format: "post",
      creator: creator.address,
      width: 3000,
      height: 2002,
      curvePreset: "content",
    });
    // 0.0004 ETH opening cap: the whole curve fills for about a tenth of a cent.
    const hash = await walletOf(creator).writeContract({
      address: deployed!.factory,
      abi: junoFactoryAbi,
      functionName: "launch",
      args: [{ name: "Graduation Day", symbol: "GRAD", metadataURI: pinned.uri, preset: 0, quote: "0x0000000000000000000000000000000000000000", p0: launchP0(parseEther("0.0004")), capFp: 25n * 10n ** 18n }, 0n],
    });
    await client.waitForTransactionReceipt({ hash });
    const recorded = await record(hash);
    progress.coins.GRAD = recorded.launched!;
    save();
    console.log(`  launched GRAD: ${recorded.launched!.token}`);
  }

  const grad = progress.coins.GRAD;
  type CoinView = { coin: { quoteUsdRate: number | null; curve: { graduated: boolean; progress: number; raisedUsd: number; thresholdUsd: number } } };
  const before = await api<CoinView>(`/api/juno/coins/${grad.token}?chainId=${CHAIN}`);
  if (!before.coin.curve.graduated && before.coin.curve.progress < 1) {
    // Overpay on purpose: a buy that fills the curve is charged only for what
    // is left, plus its fee, and the change comes straight back.
    const rate = before.coin.quoteUsdRate ?? 1;
    const left = (before.coin.curve.thresholdUsd - before.coin.curve.raisedUsd) / rate;
    const amountIn = Math.max(left * 1.5, 0.0005).toFixed(6);
    const build = await api<{ steps: Step[]; quote: { fillsCurve: boolean } }>("/api/juno/tx/swap", {
      chainId: CHAIN,
      curve: grad.curve,
      trader: accounts.demo_rio.address,
      side: "buy",
      amountIn,
    });
    const hash = await sendSteps(accounts.demo_rio, build.steps);
    const recorded = await record(hash);
    console.log(`  filled GRAD with ${amountIn} ETH (fills: ${build.quote.fillsCurve}) ${hash}${(recorded as { autoGraduated?: unknown }).autoGraduated ? " — the server graduated it" : ""}`);
  }
  const after = await api<CoinView>(`/api/juno/coins/${grad.token}?chainId=${CHAIN}`);
  if (!after.coin.curve.graduated && after.coin.curve.progress >= 1) {
    const build = await api<{ steps: Step[] }>("/api/juno/tx/graduate", { chainId: CHAIN, curve: grad.curve, caller: accounts.demo_rio.address });
    const hash = await sendSteps(accounts.demo_rio, build.steps);
    await record(hash);
    console.log(`  graduated GRAD ${hash}`);
    progress.graduated = hash;
  } else if (after.coin.curve.graduated) {
    progress.graduated = progress.graduated ?? "done";
    console.log("  GRAD graduated");
  }
  save();
}

async function social(accounts: Record<Name, PrivateKeyAccount>) {
  for (const comment of COMMENTS) {
    const id = `${comment.who}:${comment.coin}`;
    const coin = progress.coins[comment.coin];
    if (progress.comments[id] || !coin) continue;
    await api("/api/juno/comments", { chainId: CHAIN, coin: coin.token, wallet: accounts[comment.who].address, body: comment.body });
    progress.comments[id] = true;
    save();
  }
  if (!progress.social.likes) {
    const keys = Object.keys(progress.coins);
    for (const [i, name] of WALLETS.entries()) {
      for (const key of keys.filter((_, j) => (i + j) % 2 === 0).slice(0, 4)) {
        await api("/api/juno/likes", { chainId: CHAIN, coin: progress.coins[key].token, wallet: accounts[name].address, like: true });
      }
    }
    progress.social.likes = true;
    save();
  }
  if (!progress.social.follows) {
    for (const [i, name] of WALLETS.entries()) {
      const target = WALLETS[(i + 1) % WALLETS.length];
      await api("/api/juno/follow", { chainId: CHAIN, follower: accounts[name].address, target: accounts[target].address, follow: true });
    }
    progress.social.follows = true;
    save();
  }
  if (!progress.social.posts && progress.coins.TIDE && progress.coins.TSLA) {
    await api("/api/juno/posts", { chainId: CHAIN, authorWallet: accounts.demo_kai.address, body: "Posted my first reel tonight. It is a market now.", token: progress.coins.TIDE.token });
    await api("/api/juno/posts", { chainId: CHAIN, authorWallet: accounts.demo_maya.address, body: "The TSLA tracker refused my big buy. Held to the stock, as promised.", token: progress.coins.TSLA.token });
    progress.social.posts = true;
    save();
  }
  console.log("  comments, likes, follows and posts done");
}

async function main() {
  console.log(`Juno demo on ${isLocal ? "a local fork" : "Arbitrum Sepolia"} via ${API}`);
  const accounts = Object.fromEntries(WALLETS.map((name) => [name, keyFor(name)])) as Record<Name, PrivateKeyAccount>;
  for (const name of WALLETS) console.log(`  ${name} ${accounts[name].address}`);

  console.log("\nfunding"); await fund(accounts);
  console.log("\nnames"); await claimNames(accounts);
  console.log("\nposts and reels"); await launchPosts(accounts);
  console.log("\nstock trackers"); await launchTrackers(accounts.demo_maya);
  console.log("\ntrades"); await trade(accounts);
  console.log("\ngraduation"); await graduate(accounts);
  console.log("\nsocial"); await social(accounts);

  const coins = await api<{ coins: Array<{ symbol: string; volume24h: number; holders: number; curve: { graduated: boolean } }> }>(`/api/juno/coins?chainId=${CHAIN}&limit=60`);
  console.log(`\n${coins.coins.length} markets:`);
  for (const coin of coins.coins) console.log(`  ${coin.symbol.padEnd(8)} vol24h $${coin.volume24h.toFixed(2)}  holders ${coin.holders}${coin.curve.graduated ? "  graduated" : ""}`);
  process.exit(0);
}

main().catch((error) => {
  console.error(`\ndemo failed: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
});
