/**
 * End-to-end on the local Nitro node, through the web app in a real Chromium
 * with a real (injected) wallet: every step is a UI action, checked against
 * the chain and the API afterwards. `node scripts/localnet/e2e.mjs [stage]`.
 * Needs: scripts/localnet/up.sh, the local API (:3111), the local web (:8091).
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, devices } from "playwright";
import { createPublicClient, formatEther, formatUnits, http, erc20Abi } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = process.env.JUNO_LOCAL_APP ?? "http://localhost:8091";
const API = process.env.JUNO_LOCAL_API ?? "http://localhost:3111";
const RPC = process.env.ARB_LOCAL_RPC ?? "http://localhost:8747";
const CHAIN_ID = 412346;
const STATE = join(HERE, "..", "..", ".juno", "localnet-e2e.json");
const state = existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : {};
const save = () => writeFileSync(STATE, JSON.stringify(state, null, 1));
const chain = createPublicClient({ transport: http(RPC) });
const book = readFileSync(join(HERE, "..", "..", "config", "addresses.ts"), "utf8");
const local = book.slice(book.indexOf("  412346: {"));
const addr = (key) => local.match(new RegExp(`${key}: "(0x[0-9a-fA-F]{40})"`))?.[1];
const USDC = addr("usdc");

let failures = 0;
export function check(id, ok, detail) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${id}  ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 300)}`);
  if (!ok) failures++;
}

/** A browser with the wallet of `who` (a key kept in the state file). */
export async function open(who) {
  state.keys ??= {};
  state.keys[who] ??= generatePrivateKey();
  save();
  const browser = await chromium.launch({
    executablePath: process.env.JUNO_CHROMIUM ?? join(homedir(), "Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell"),
  });
  const context = await browser.newContext({ ...devices["iPhone 15 Pro"], viewport: { width: 393, height: 852 } });
  await context.addInitScript({ content: `window.__JUNO_WALLET = ${JSON.stringify({ key: state.keys[who], rpc: RPC, chainId: CHAIN_ID })};\n${readFileSync(join(HERE, "wallet.js"), "utf8")}` });
  const page = await context.newPage();
  const errors = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text().slice(0, 200)));
  page.on("pageerror", (e) => errors.push(`pageerror ${String(e).slice(0, 200)}`));
  page.on("response", (r) => r.status() >= 400 && errors.push(`${r.status()} ${r.request().method()} ${r.url().slice(0, 120)}`));
  return { browser, page, errors, address: privateKeyToAccount(state.keys[who]).address.toLowerCase() };
}

export const text = async (page) => (await page.locator("body").innerText()).replace(/\n+/g, " / ");
/** Tap the visible element whose text is exactly `label` (the last one when several are on screen). */
export async function tap(page, label, { last = false, wait = 1200 } = {}) {
  const loc = page.getByText(label, { exact: true }).locator("visible=true");
  await (last ? loc.last() : loc.first()).click({ timeout: 15000 });
  await page.waitForTimeout(wait);
}
export async function waitFor(page, needle, ms = 60000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if ((await text(page)).includes(needle)) return true;
    await page.waitForTimeout(500);
  }
  return false;
}
const eth = async (a) => Number(formatEther(await chain.getBalance({ address: a })));
const usdc = async (a) => Number(formatUnits(await chain.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [a] }), 6));

// ---------------- stage: wallet (L1 connect, L2 faucet, L3 name)
async function walletStage() {
  const { browser, page, errors, address } = await open("alice");
  await page.goto(`${APP}/profile`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1500);
  await tap(page, "Sign in", { last: true });
  const sheet = await waitFor(page, "Connect a browser wallet", 10000);
  await tap(page, "Connect a browser wallet", { last: true, wait: 3000 });
  const shown = (await text(page)).toLowerCase().includes(address.slice(0, 6));
  check("L1 connect a browser wallet: the profile shows it", sheet && shown, { address, sheet, shown });

  const before = await eth(address);
  await tap(page, "Get test ETH", { last: true, wait: 1000 });
  let funded = false;
  for (let i = 0; i < 40 && !funded; i++) { await page.waitForTimeout(1000); funded = (await eth(address)) > before; }
  const [e, u] = [await eth(address), await usdc(address)];
  check("L2 faucet: 0.02 ETH + 1,000 test USDC land on-chain", funded && Math.abs(e - before - 0.02) < 1e-9 && u === 1000, { eth: e, usdc: u });
  const again = await fetch(`${API}/api/juno/faucet`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chainId: CHAIN_ID, wallet: address }) });
  check("L2 faucet: a second request the same day is 429 with the wait", again.status === 429 && typeof (await again.json()).retryAfterSeconds === "number", again.status);

  const name = `alice_${address.slice(2, 6)}`;
  await tap(page, "Choose a name", { last: true });
  await page.getByPlaceholder("yourname").fill(name);
  await tap(page, "Save", { last: true, wait: 3000 });
  const names = await (await fetch(`${API}/api/juno/profiles?wallets=${address}&chainId=${CHAIN_ID}`)).json();
  const onScreen = await waitFor(page, `@${name}`, 15000);
  check("L3 name claim: signed in the wallet, stored, shown", names.names?.[address] === name && onScreen, names.names);
  check("L1-L3 console/network clean", errors.length === 0, errors);
  state.alice = { address, name };
  save();
  await browser.close();
}

// ---------------- stage: launch (L4 photo post, L5 reel)
const PHOTO = process.env.JUNO_E2E_PHOTO ?? "/Volumes/Extreme SSD/Projects/zorr-solana/.juno/video/final/hf/assets/poster-NEON.jpg";
const VIDEO = process.env.JUNO_E2E_VIDEO ?? join(HERE, "..", "..", ".juno", "video", "raw", "03-stocks.mp4");
const FACTORY = addr("factory");
const LAUNCHED = "Launched(address,address,address,uint8,address,address,uint16,uint256,uint256,uint256,uint256,address,string)";

async function launch(page, { kind, file, name, symbol, caption }) {
  await page.goto(`${APP}/post${kind === "reel" ? "?format=reel" : ""}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1500);
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), tap(page, kind === "reel" ? "Add a video" : "Add a photo", { wait: 0 })]);
  await chooser.setFiles(file);
  await page.waitForTimeout(2500);
  await page.getByPlaceholder("Night Market", { exact: true }).fill(name);
  await page.getByPlaceholder("NIGHT", { exact: true }).fill(symbol);
  await page.getByPlaceholder(kind === "reel" ? "Street level, 2am." : "Say what this is", { exact: true }).fill(caption);
  await tap(page, kind === "reel" ? "Launch reel" : "Launch post", { last: true, wait: 1000 });
  const listed = await waitFor(page, "Listed on Juno", 180000);
  const log = await text(page);
  return { listed, log: log.slice(log.indexOf("pinned to IPFS") - 30, log.indexOf("Listed on Juno") + 60) };
}

async function launchedBy(creator) {
  const { keccak256, toHex } = await import("viem");
  const logs = await chain.getLogs({ address: FACTORY, fromBlock: 0n, toBlock: "latest" });
  return logs
    .filter((l) => l.topics[0] === keccak256(toHex(LAUNCHED)) && `0x${l.topics[3].slice(26)}` === creator)
    .map((l) => ({ curve: `0x${l.topics[1].slice(26)}`, token: `0x${l.topics[2].slice(26)}` }));
}

async function launchStage() {
  const { browser, page, errors, address } = await open("alice");
  await page.goto(`${APP}/profile`, { waitUntil: "networkidle" });
  if ((await text(page)).includes("No wallet yet")) {
    await tap(page, "Sign in", { last: true });
    await tap(page, "Connect a browser wallet", { last: true, wait: 3000 });
  }
  const before = (await launchedBy(address)).length;
  const post = await launch(page, { kind: "post", file: PHOTO, name: "Neon Rain", symbol: "NEON", caption: "City after rain, launched end to end." });
  const afterPost = await launchedBy(address);
  const coin = afterPost.at(-1);
  const detail = coin && (await (await fetch(`${API}/api/juno/coins/${coin.token}?chainId=${CHAIN_ID}`)).json());
  check("L4 photo post: pinned, launched by the wallet, listed", post.listed && afterPost.length === before + 1 && detail?.coin?.symbol === "NEON" && detail.coin.format === "post" && /^(https?:|ipfs:|\/api\/ipfs\/)/.test(detail.coin.media?.url ?? ""), { log: post.log, token: coin?.token, media: detail?.coin?.media?.url?.slice(0, 60) });
  state.neon = coin;
  save();
  await page.goto(`${APP}/social`, { waitUntil: "networkidle" });
  check("L4 the new post is in the feed", await waitFor(page, "$NEON", 20000), "feed shows $NEON");

  const reel = await launch(page, { kind: "reel", file: VIDEO, name: "Stock Walk", symbol: "WALK", caption: "Street level, recorded on the app." });
  const afterReel = await launchedBy(address);
  const r = afterReel.at(-1);
  const rd = r && (await (await fetch(`${API}/api/juno/coins/${r.token}?chainId=${CHAIN_ID}`)).json());
  check("L5 reel: video + poster pinned, launched, listed as a reel", reel.listed && afterReel.length === before + 2 && rd?.coin?.format === "reel" && rd.coin.media?.kind === "video" && !!rd.coin.media?.posterUrl && rd.coin.media.posterUrl !== rd.coin.media.url, { log: reel.log, media: rd?.coin?.media });
  state.walk = r;
  save();
  await page.goto(`${APP}/reels`, { waitUntil: "networkidle" });
  check("L5 the reel is in Reels", await waitFor(page, "Stock Walk", 20000), "reels shows Stock Walk");
  check("L4-L5 console/network clean", errors.length === 0, errors);
  await browser.close();
}

// ---------------- stage: trade (L6 buy with a comment, L7 sell, L9 creator claim)
async function signIn(page) {
  await page.goto(`${APP}/profile`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1200);
  if ((await text(page)).includes("No wallet yet")) {
    await tap(page, "Sign in", { last: true });
    await tap(page, "Connect a browser wallet", { last: true, wait: 3000 });
  }
}
const sheetButton = (page, name) => page.getByRole("button", { name, exact: true }).locator("visible=true");
/** Type an amount on the sheet's keypad. */
async function keypad(page, value) {
  for (const key of value) {
    await page.getByRole("button", { name: key, exact: true }).locator("visible=true").last().click();
    await page.waitForTimeout(120);
  }
}
const balanceOf = async (token, who) => chain.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [who] });
const coinDetail = async (token) => (await fetch(`${API}/api/juno/coins/${token}?chainId=${CHAIN_ID}`)).json();

async function tradeStage() {
  const coin = state.neon;
  if (!coin) throw new Error("run the launch stage first");
  const { browser, page, errors, address } = await open("bob");
  await signIn(page);
  if ((await eth(address)) < 0.01) {
    await tap(page, "Get test ETH", { last: true, wait: 1000 });
    for (let i = 0; i < 40 && (await eth(address)) < 0.01; i++) await page.waitForTimeout(1000);
  }

  // L6: open the coin, Buy, type 0.002 ETH, add a comment, confirm.
  await page.goto(`${APP}/coin/${coin.token}`, { waitUntil: "networkidle" });
  await waitFor(page, "Neon Rain", 20000);
  const ethBefore = await eth(address);
  await sheetButton(page, "Buy").last().click();
  await page.waitForTimeout(1200);
  await keypad(page, "0.002");
  const quoted = await waitFor(page, "You'll receive", 20000);
  const note = `bought on localnet ${Date.now().toString(36)}`;
  await page.getByPlaceholder("Add a comment...", { exact: true }).fill(note);
  await sheetButton(page, "Buy").last().click();
  const done = await waitFor(page, "Done", 90000);
  const held = await balanceOf(coin.token, address);
  const d1 = await coinDetail(coin.token);
  const buyRow = d1.activity?.find((a) => a.side === "buy" && a.wallet?.toLowerCase?.() === address) ?? d1.activity?.find((a) => a.side === "buy");
  const comments = (await (await fetch(`${API}/api/juno/comments?coin=${coin.token}&chainId=${CHAIN_ID}`)).json()).comments ?? [];
  const ethAfter = await eth(address);
  check("L6 buy through the sheet: quoted, signed, tokens held, in activity", quoted && done && held > 0n && !!buyRow && ethBefore - ethAfter >= 0.002, { held: String(held), spent: (ethBefore - ethAfter).toFixed(6), buyRow: buyRow?.txHash });
  check("L6 the trade's comment is posted with the trade", comments.some((c) => c.body === note), comments.slice(0, 2).map((c) => c.body));
  const explorerLink = await page.getByText(/^View on /).locator("visible=true").first().textContent().catch(() => null);
  check("L6 the receipt links the chain's explorer", explorerLink === "View on the local explorer", explorerLink);
  await tap(page, "Done", { last: true });

  // L7: sell half from the same sheet.
  await sheetButton(page, "Buy").last().click();
  await page.waitForTimeout(1200);
  await sheetButton(page, "Sell").first().click();
  await page.waitForTimeout(800);
  await tap(page, "50%", { last: true });
  const sellQuoted = await waitFor(page, "You'll receive", 20000);
  await sheetButton(page, "Sell").last().click();
  const sold = await waitFor(page, "Sold ", 90000);
  const left = await balanceOf(coin.token, address);
  const d2 = await coinDetail(coin.token);
  // Half, rounded down to six figures: never more than half leaves.
  const half = held / 2n;
  check("L7 sell 50% through the sheet: half the tokens leave, in activity", sellQuoted && sold && left >= half && left - half <= held / 100000n && d2.activity?.some((a) => a.side === "sell"), { held: String(held), left: String(left) });
  await tap(page, "Done", { last: true });

  await sheetButton(page, "Buy").last().click();
  await page.waitForTimeout(1200);
  await sheetButton(page, "Sell").first().click();
  await page.waitForTimeout(800);
  await tap(page, "100%", { last: true });
  const allQuoted = await waitFor(page, "You'll receive", 20000);
  await sheetButton(page, "Sell").last().click();
  const soldAll = await waitFor(page, "Sold ", 90000);
  const none = await balanceOf(coin.token, address);
  check("L7 sell 100%: the whole holding leaves, no dust", allQuoted && soldAll && none === 0n, { left: String(none) });
  await tap(page, "Done", { last: true });
  check("L6-L7 console/network clean", errors.length === 0, errors);
  state.bob = { address };
  save();
  await browser.close();

  // L9: the creator claims the fees those trades paid.
  const alice = await open("alice");
  await signIn(alice.page);
  await alice.page.goto(`${APP}/coin/${coin.token}`, { waitUntil: "networkidle" });
  const offered = await waitFor(alice.page, "in creator fees", 30000);
  const before = await eth(alice.address);
  await alice.page.getByText(/^Claim .* in creator fees$/).locator("visible=true").first().click();
  const claimed = await waitFor(alice.page, "Claimed ", 90000);
  const after = await eth(alice.address);
  const d3 = await coinDetail(coin.token);
  check("L9 creator claim: offered to the creator only, paid on-chain, rewards reset", offered && claimed && after > before - 0.0005 && (d3.coin?.creatorRewards ?? 1) < 1e-9, { gained: (after - before).toFixed(8), rewards: d3.coin?.creatorRewards });
  check("L9 console/network clean", alice.errors.length === 0, alice.errors);
  await alice.browser.close();
}

// ---------------- stage: trackers (L10 USDC approve + buy in band, the band refusal; L11 market closed)
const ENV = Object.fromEntries(
  readFileSync(join(HERE, "..", "..", ".env"), "utf8").split("\n").filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]),
);
const keeperKey = () => { const k = ENV.KEEPER_PRIVATE_KEY; return k.startsWith("0x") ? k : `0x${k}`; };
const MOCK_ABI = [
  { type: "function", name: "setAnswer", stateMutability: "nonpayable", inputs: [{ type: "int256" }, { type: "uint256" }], outputs: [] },
  { type: "function", name: "latestRoundData", stateMutability: "view", inputs: [], outputs: [{ type: "uint80" }, { type: "int256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint80" }] },
];
const MINT_ABI = [{ type: "function", name: "mint", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [] }];
async function keeperWrite(address, abi, functionName, args) {
  const { createWalletClient, defineChain } = await import("viem");
  const local = defineChain({ id: CHAIN_ID, name: "Arbitrum Local", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
  const wallet = createWalletClient({ account: privateKeyToAccount(keeperKey()), chain: local, transport: http(RPC) });
  const hash = await wallet.writeContract({ address, abi, functionName, args });
  const receipt = await chain.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${functionName} reverted`);
  return hash;
}

async function trackerStage() {
  const { browser, page, errors, address } = await open("alice");
  await signIn(page);
  const stocks = await (await fetch(`${API}/api/juno/stocks?chainId=${CHAIN_ID}`)).json();
  const tsla = stocks.find((s) => s.symbol === "TSLA")?.trackers?.[0];
  if (!tsla) throw new Error("run scripts/localnet/trackers.ts first");
  const token = tsla.address;

  for (let i = 0; i < 30 && (await coinDetail(token)).coin?.nav?.marketOpen !== true; i++) await new Promise((r) => setTimeout(r, 3000));
  // L10: from the Trade tab to the tracker, spend 50 USDC: approve, then buy.
  await page.goto(`${APP}/trade`, { waitUntil: "networkidle" });
  const listed = await waitFor(page, "$jTSLA", 20000);
  await page.getByText(/^\$jTSLA/).locator("visible=true").first().click();
  await page.waitForTimeout(1500);
  await waitFor(page, "jTSLA", 20000);
  const usdcBefore = await usdc(address);
  const heldBefore = await balanceOf(token, address);
  await sheetButton(page, "Buy").last().click();
  await page.waitForTimeout(1200);
  await keypad(page, "50");
  const twoSteps = await waitFor(page, "Approve USDC  →  Buy", 20000);
  await sheetButton(page, "Buy").last().click();
  const bought = await waitFor(page, "Done", 120000);
  const usdcAfter = await usdc(address);
  const held = await balanceOf(token, address);
  check("L10 tracker buy: Trade tab → tracker, Approve USDC → Buy, 50 USDC in, tokens out", listed && twoSteps && bought && Math.abs(usdcBefore - usdcAfter - 50) < 1e-6 && held > heldBefore, { spent: usdcBefore - usdcAfter, held: String(held) });
  await tap(page, "Done", { last: true });

  // L10: a buy that would leave the band is refused in words, before signing.
  // TestUSDC mints at most 10,000 at a time.
  for (let i = 0; i < 3; i++) await keeperWrite(USDC, MINT_ABI, "mint", [address, 10000n * 10n ** 6n]);
  await page.reload({ waitUntil: "networkidle" });
  await waitFor(page, "jTSLA", 20000);
  await sheetButton(page, "Buy").last().click();
  await page.waitForTimeout(1200);
  await keypad(page, "20000");
  const refused = await waitFor(page, "above the stock. Try a smaller amount.", 20000);
  const submit = sheetButton(page, "Buy").last();
  const disabled = await submit.evaluate((el) => ({ aria: el.getAttribute("aria-disabled"), attr: el.hasAttribute("disabled"), html: el.outerHTML.slice(0, 160) })).catch((e) => String(e));
  check("L10 out-of-band buy: refused in words, nothing to sign", refused && (disabled?.aria === "true" || disabled?.attr === true), { refused, disabled });
  await page.getByRole("button", { name: "Close", exact: true }).locator("visible=true").last().click();
  check("L10 console/network clean", errors.length === 0, errors);
  errors.length = 0;

  // L11: the stock price goes stale → buys pause, sells still work.
  // Reads first, so each route's on-read mirror runs now and is throttled for
  // 5 minutes (every route bundle keeps its own throttle in dev).
  await fetch(`${API}/api/juno/stocks?chainId=${CHAIN_ID}`);
  await fetch(`${API}/api/juno/coins?chainId=${CHAIN_ID}`);
  await fetch(`${API}/api/juno/coins/${token}?chainId=${CHAIN_ID}`);
  await new Promise((r) => setTimeout(r, 10000));
  const feed = tsla.reference?.feed ?? stocks.find((s) => s.symbol === "TSLA").feed;
  const [, answer, , updatedAt] = await chain.readContract({ address: feed, abi: MOCK_ABI, functionName: "latestRoundData" });
  const stale = BigInt(Math.floor(Date.now() / 1000) - 27 * 3600);
  await keeperWrite(feed, MOCK_ABI, "setAnswer", [answer, stale]);
  try {
  // The API trusts a feed reading for 30 s; wait until it says closed.
  for (let i = 0; i < 30 && (await coinDetail(token)).coin?.nav?.marketOpen !== false; i++) await page.waitForTimeout(3000);
  await page.reload({ waitUntil: "networkidle" });
  const closedButton = await waitFor(page, "Sell · market closed", 30000);
  await sheetButton(page, "Sell · market closed").last().click();
  await page.waitForTimeout(1200);
  await tap(page, "100%", { last: true });
  const quoted = await waitFor(page, "You'll receive", 20000);
  const beforeSell = await usdc(address);
  await sheetButton(page, "Sell").last().click();
  const sold = await waitFor(page, "Sold ", 120000);
  const left = await balanceOf(token, address);
  check("L11 market closed: the coin offers sells only, and the sell settles in USDC", closedButton && quoted && sold && left === 0n && (await usdc(address)) > beforeSell, { left: String(left) });
  const refusal = await (await fetch(`${API}/api/juno/tx/swap`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chainId: CHAIN_ID, curve: token, side: "buy", amountIn: "10", quoteOnly: true }) })).json();
  check("L11 market closed: the API refuses a buy with the reason", refusal.refusal?.reason === "MarketClosed", refusal.refusal);
  await tap(page, "Done", { last: true });
  check("L11 console/network clean", errors.length === 0, errors);
  } finally {
    // Put the real price and time back (the mirror would, after its throttle).
    await keeperWrite(feed, MOCK_ABI, "setAnswer", [answer, updatedAt]);
  }
  await browser.close();
}

const stages = { wallet: walletStage, launch: launchStage, trade: tradeStage, trackers: trackerStage };
const only = process.argv[2];
for (const [name, run] of Object.entries(stages)) if (!only || only === name) await run();
console.log(failures ? `\n${failures} FAILED` : "\nall local items pass");
process.exitCode = failures ? 1 : 0;
