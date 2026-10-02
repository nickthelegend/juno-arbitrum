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
export async function open(who, { chrome = false } = {}) {
  state.keys ??= {};
  state.keys[who] ??= generatePrivateKey();
  save();
  // Google Chrome for media: Chromium builds have no H.264, and the reels are MP4.
  const browser = await chromium.launch(
    chrome
      ? { channel: "chrome", headless: true }
      : { executablePath: process.env.JUNO_CHROMIUM ?? join(homedir(), "Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell") },
  );
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
  try {
    await (last ? loc.last() : loc.first()).click({ timeout: 15000 });
  } catch (error) {
    const shot = join(HERE, "..", "..", ".juno", `e2e-fail-${label.replace(/[^a-z0-9]+/gi, "_")}.png`);
    await page.screenshot({ path: shot }).catch(() => {});
    console.log(`(screenshot ${shot})\n${(await text(page)).slice(0, 600)}`);
    throw error;
  }
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
  await page.reload({ waitUntil: "networkidle" });
  const usedToday = await waitFor(page, "Faucet used today", 15000);
  check("L2 after a drip the card says the faucet is used today, with the wait", usedToday && (await text(page)).includes("This wallet already used the faucet today"), usedToday);

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
  const captioned = await waitFor(page, "Caption posted", 20000);
  const log = await text(page);
  return { listed: listed && captioned, log: log.slice(log.indexOf("pinned to IPFS") - 30, log.indexOf("Listed on Juno") + 80) };
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
/**
 * Fund a test wallet: the faucet through the UI when it will drip; when this
 * network used its daily share (every local wallet is one IP), the card must
 * say so, and the local keeper tops the wallet up instead.
 */
async function fundWallet(page, address, need = 0.01) {
  if ((await eth(address)) >= need) return;
  await page.goto(`${APP}/profile`, { waitUntil: "networkidle" });
  await page.waitForTimeout(2000);
  const shown = await text(page);
  if (shown.includes("Get test ETH")) {
    await tap(page, "Get test ETH", { last: true, wait: 1000 });
    for (let i = 0; i < 40 && (await eth(address)) < need; i++) await page.waitForTimeout(1000);
  } else {
    check("L2 a refused faucet is explained before asking", shown.includes("Faucet used today") && /Try again in \d/.test(shown), shown.slice(shown.indexOf("Faucet"), shown.indexOf("Faucet") + 120));
  }
  if ((await eth(address)) < need) {
    const { createWalletClient, defineChain, parseEther } = await import("viem");
    const local = defineChain({ id: CHAIN_ID, name: "Arbitrum Local", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
    const keeper = createWalletClient({ account: privateKeyToAccount(keeperKey()), chain: local, transport: http(RPC) });
    await chain.waitForTransactionReceipt({ hash: await keeper.sendTransaction({ to: address, value: parseEther(String(Math.max(0.05, need * 2))) }) });
  }
}

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
  await fundWallet(page, address);

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

// ---------------- stage: graduate (L12 a post fills its curve and moves to Uniswap v3)
const POOL_ABI = [
  { type: "function", name: "liquidity", stateMutability: "view", inputs: [], outputs: [{ type: "uint128" }] },
  { type: "function", name: "token0", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
];
async function graduateStage() {
  const { browser, page, errors, address } = await open("carol");
  await signIn(page);
  // Filling a curve takes ~0.05 ETH, more than the faucet's 0.02.
  await fundWallet(page, address, 0.1);
  const symbol = `G${Date.now().toString(36).slice(-4).toUpperCase()}`;
  const launched = await launch(page, { kind: "post", file: PHOTO, name: "Last Light", symbol, caption: "Filling this one to the top." });
  const coin = (await launchedBy(address)).at(-1);
  check("L12 carol launches a post to fill", launched.listed && !!coin, { symbol, token: coin?.token });

  await page.goto(`${APP}/coin/${coin.token}`, { waitUntil: "networkidle" });
  await waitFor(page, "Last Light", 20000);
  await sheetButton(page, "Buy").last().click();
  await page.waitForTimeout(1200);
  await keypad(page, "0.06");
  await waitFor(page, "You'll receive", 20000);
  await sheetButton(page, "Buy").last().click();
  const filled = await waitFor(page, "Done", 120000);
  await tap(page, "Done", { last: true });
  let detail = await coinDetail(coin.token);
  for (let i = 0; i < 20 && !detail.coin?.curve?.graduated; i++) { await page.waitForTimeout(2000); detail = await coinDetail(coin.token); }
  const pool = detail.coin?.graduatedPool;
  const liquidity = pool ? await chain.readContract({ address: pool, abi: POOL_ABI, functionName: "liquidity" }) : 0n;
  check("L12 the buy fills the curve and it graduates: a Uniswap v3 pool with liquidity", filled && detail.coin?.curve?.graduated === true && liquidity > 0n, { pool, liquidity: String(liquidity), progress: detail.coin?.curve?.progress });

  await page.reload({ waitUntil: "networkidle" });
  const onUniswap = await waitFor(page, "Trading on Uniswap ↗", 20000);
  const [popup] = await Promise.all([page.waitForEvent("popup", { timeout: 10000 }).catch(() => null), sheetButton(page, "Trading on Uniswap ↗").last().click()]);
  if (popup) await popup.waitForURL((u) => u.href !== "about:blank" && u.href !== "", { timeout: 10000 }).catch(() => {});
  const url = popup?.url() ?? null;
  const explorerAnswer = url ? await (await fetch(url)).json().catch(() => null) : null;
  check("L12 the coin says it trades on Uniswap and links the pool on the chain's explorer", onUniswap && url === `${API}/api/explorer/address/${pool}` && !!explorerAnswer, { url, explorer: explorerAnswer && Object.keys(explorerAnswer) });
  const refusal = await (await fetch(`${API}/api/juno/tx/swap`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chainId: CHAIN_ID, curve: coin.token, side: "buy", amountIn: "0.001", quoteOnly: true }) })).json();
  check("L12 the graduated curve takes no more curve trades", refusal.refusal?.message === "This market moved to Uniswap.", refusal.refusal ?? refusal);
  check("L12 console/network clean", errors.length === 0, errors);
  state.graduated = { ...coin, pool };
  save();
  await browser.close();
}

// ---------------- stage: social (L8 like + follow, L14 reply thread, L13 watch/alert/plan, L15 portfolio + profile)
const getJson = async (path) => (await fetch(`${API}${path}${path.includes("?") ? "&" : "?"}chainId=${CHAIN_ID}`)).json();

async function socialStage() {
  const coin = state.neon;
  const alice = state.alice;
  if (!coin || !alice) throw new Error("run the wallet and launch stages first");
  const { browser, page, errors, address } = await open("bob");
  await signIn(page);

  // L8: on the feed, the newest Neon Rain card: like it and follow its creator.
  await page.goto(`${APP}/social`, { waitUntil: "networkidle" });
  await waitFor(page, "Neon Rain", 20000);
  const card = page.getByText("Neon Rain", { exact: false }).locator("visible=true").first().locator("xpath=ancestor::div[.//*[@aria-label='Like' or @aria-label='Unlike']][1]");
  const likeBefore = (await getJson(`/api/juno/likes?coins=${coin.token}&viewer=${address}`)).counts?.[coin.token];
  if (likeBefore?.viewerLiked) await card.locator("[aria-label='Unlike']").first().click();
  await page.waitForTimeout(1500);
  await card.locator("[aria-label='Like']").first().click();
  let likes;
  for (let i = 0; i < 20; i++) { likes = (await getJson(`/api/juno/likes?coins=${coin.token}&viewer=${address}`)).counts?.[coin.token]; if (likes?.viewerLiked) break; await page.waitForTimeout(500); }
  check("L8 like from the feed: stored against the wallet's session", likes?.viewerLiked === true && likes.likes >= 1, likes);
  const followLabel = card.locator("[aria-label^='Follow '], [aria-label^='Unfollow ']").first();
  if ((await followLabel.getAttribute("aria-label"))?.startsWith("Unfollow")) { await followLabel.click(); await page.waitForTimeout(1500); }
  await card.locator("[aria-label^='Follow ']").first().click();
  let follow;
  for (let i = 0; i < 20; i++) { follow = await getJson(`/api/juno/follow?wallet=${alice.address}&viewer=${address}`); if (follow.viewerFollows) break; await page.waitForTimeout(500); }
  check("L8 follow the creator from the feed", follow?.viewerFollows === true && follow.followers >= 1, { followers: follow?.followers, viewerFollows: follow?.viewerFollows });

  // L14: the caption is the creator's post; reply under it.
  const threadLink = card.getByText(/^(Reply|\d+ repl(y|ies))$/).first();
  const hasThread = (await threadLink.count()) > 0;
  let replied = false, replyCount = null, postId = null;
  if (hasThread) {
    await threadLink.click();
    await page.waitForURL(/\/post\//, { timeout: 15000 });
    postId = page.url().split("/post/")[1];
    await waitFor(page, "City after rain", 20000);
    const words = `nice shot ${Date.now().toString(36)}`;
    await page.getByPlaceholder("Write a reply…", { exact: true }).fill(words);
    await sheetButton(page, "Reply").last().click();
    replied = await waitFor(page, words, 20000);
    replyCount = (await (await fetch(`${API}/api/juno/posts/${postId}?lookup=1`)).json()).replyCount;
  }
  check("L14 the caption opens its thread and a reply lands in it", hasThread && replied && replyCount >= 1, { postId, replyCount });

  // L13: watch the coin, set a price alert, start a weekly plan and put into it.
  await page.goto(`${APP}/coin/${coin.token}`, { waitUntil: "networkidle" });
  await waitFor(page, "Neon Rain", 20000);
  const watch = page.locator("[aria-label='Watch'], [aria-label='Stop watching']").locator("visible=true").first();
  if ((await watch.getAttribute("aria-label")) === "Stop watching") { await watch.click(); await page.waitForTimeout(1500); }
  await page.locator("[aria-label='Watch']").locator("visible=true").first().click();
  let watching;
  for (let i = 0; i < 20; i++) { watching = await getJson(`/api/juno/watchlist?wallet=${address}`); if (watching.items?.some((w) => (w.coin?.address ?? w.address ?? w.token) === coin.token)) break; await page.waitForTimeout(500); }
  const watched = watching.items?.find((w) => (w.coin?.address ?? w.address ?? w.token) === coin.token);
  check("L13 watch from the coin page: on the wallet's watchlist", !!watched, watching.items?.length);

  await tap(page, "Details", { last: true });
  await tap(page, "Set", { last: true });
  const priceNow = (await coinDetail(coin.token)).coin.priceUsd;
  await page.getByPlaceholder("0.00", { exact: true }).locator("visible=true").last().fill((priceNow * 2).toFixed(14).replace(/0+$/, ""));
  await sheetButton(page, "Set alert").last().click();
  let alert;
  for (let i = 0; i < 20; i++) { alert = (await getJson(`/api/juno/watchlist?wallet=${address}`)).items?.find((w) => (w.coin?.address ?? w.address ?? w.token) === coin.token); if (alert?.alertPrice) break; await page.waitForTimeout(500); }
  check("L13 price alert set from the coin page, at the price typed", !!alert?.alertPrice && Math.abs(alert.alertPrice / (priceNow * 2) - 1) < 1e-3, { alertPrice: alert?.alertPrice, typed: priceNow * 2 });

  await page.waitForTimeout(1000);
  const plansBefore = new Set(((await getJson(`/api/juno/plans?wallet=${address}`)).plans ?? []).map((p) => p.id));
  await page.getByRole("button", { name: /^(Buy this every week|Add another schedule)$/ }).locator("visible=true").last().click();
  await page.waitForTimeout(1000);
  await page.getByPlaceholder("0.00", { exact: true }).locator("visible=true").last().fill("0.001");
  await sheetButton(page, "Start").last().click();
  let plans;
  const isNew = (p) => (p.coin?.address ?? p.token) === coin.token && !plansBefore.has(p.id);
  for (let i = 0; i < 20; i++) { plans = await getJson(`/api/juno/plans?wallet=${address}`); if (plans.plans?.some(isNew)) break; await page.waitForTimeout(500); }
  const plan = plans.plans?.find(isNew);
  check("L13 weekly plan started from the coin page", !!plan && Number(plan.amount) === 0.001, plan && { amount: plan.amount, cadence: plan.cadence });

  await page.waitForTimeout(1000);
  const coinPlans = async () => ((await getJson(`/api/juno/plans?wallet=${address}`)).plans ?? []).filter((p) => (p.coin?.address ?? p.token) === coin.token);
  const sum = (list) => list.reduce((total, p) => total + (p.contributed ?? 0), 0);
  const contributedBefore = sum(await coinPlans());
  const putIn = page.getByRole("button", { name: /^Put in .* ETH$/ }).locator("visible=true").last();
  console.log(`  (plan button: ${await putIn.textContent().catch(() => "none")})`);
  await putIn.click();
  await page.waitForTimeout(1200);
  await waitFor(page, "You'll receive", 20000);
  await sheetButton(page, "Buy").last().click();
  const put = await waitFor(page, "Done", 120000);
  await tap(page, "Done", { last: true });
  let contributedAfter = contributedBefore;
  for (let i = 0; i < 20; i++) { contributedAfter = sum(await coinPlans()); if (contributedAfter > contributedBefore) break; await page.waitForTimeout(500); }
  check("L13 a plan contribution is a real buy and counts toward its plan", put && Math.abs(contributedAfter - contributedBefore - 0.001) < 1e-9, { before: contributedBefore, after: contributedAfter });
  check("L8/L13/L14 console/network clean", errors.length === 0, errors);
  await browser.close();

  // L15: the creator's public profile, and a holder's portfolio.
  const viewer = await open("bob");
  await signIn(viewer.page);
  await viewer.page.goto(`${APP}/trader/${alice.address}`, { waitUntil: "networkidle" });
  const named = await waitFor(viewer.page, alice.name, 20000);
  const following = await viewer.page.getByRole("button", { name: "Following", exact: true }).locator("visible=true").count();
  const soldOutListed = (await text(viewer.page)).includes("0 jTSLA");
  check("L15 the creator's profile: claimed name, the viewer's follow, no sold-out holdings", named && following > 0 && !soldOutListed, { name: alice.name, following, soldOutListed });
  const holder = state.graduated ? await open("carol") : null;
  if (holder) {
    await signIn(holder.page);
    const portfolio = await (await fetch(`${API}/api/juno/portfolio/${holder.address}?chainId=${CHAIN_ID}`)).json();
    const position = portfolio.positions?.find((p) => (p.token ?? p.address ?? p.coin?.address) === state.graduated.token);
    await holder.page.goto(`${APP}/profile`, { waitUntil: "networkidle" });
    const shown = await waitFor(holder.page, "Last Light", 20000);
    check("L15 portfolio: the graduated coin is held, valued, and shown on the profile", !!position && (position.value ?? position.valueUsd ?? 0) > 0 && shown, position && { value: position.value ?? position.valueUsd, total: portfolio.totalValue });
    check("L15 console/network clean", viewer.errors.length === 0 && holder.errors.length === 0, [...viewer.errors, ...holder.errors]);
    await holder.browser.close();
  }
  await viewer.browser.close();
}

// ---------------- stage: media (L16 reels show their poster while loading, then play)
async function mediaStage() {
  const { browser, page, errors } = await open("visitor", { chrome: true });
  await page.goto(`${APP}/reels`, { waitUntil: "domcontentloaded" });
  // Poster opacity over the first reel, sampled until its video has frames.
  const sample = () =>
    page.evaluate(() => {
      const video = document.querySelector("video");
      if (!video) return null;
      const box = video.getBoundingClientRect();
      // React Native Web paints an <Image> as a div's background-image (its
      // <img> is a hidden accessibility copy), so the cover is that div.
      const covers = [...document.querySelectorAll("div")].filter((el) => {
        if (!/url\(/.test(getComputedStyle(el).backgroundImage)) return false;
        const r = el.getBoundingClientRect();
        return Math.abs(r.width - box.width) < 2 && Math.abs(r.height - box.height) < 2 && Math.abs(r.top - box.top) < 2;
      });
      const opacity = (el) => { let o = 1; for (let n = el; n && n !== document.body; n = n.parentElement) o *= parseFloat(getComputedStyle(n).opacity); return o; };
      return { t: video.currentTime, ready: video.readyState, poster: covers.length ? Math.max(...covers.map(opacity)) : null };
    });
  let first = null, playing = null;
  for (let i = 0; i < 80; i++) {
    const s = await sample();
    if (s && first === null) first = s;
    if (s && s.t > 0.5) { playing = s; break; }
    await page.waitForTimeout(500);
  }
  await page.waitForTimeout(600);
  const after = await sample();
  check("L16 the first reel shows its poster before it has frames", first !== null && (first.ready > 2 || (first.poster ?? 0) > 0.9), first);
  check("L16 the reel plays (the playhead moves) and the poster lifts", !!playing && (after?.poster ?? 0) < 0.1, { playing, after });
  check("L16 console/network clean", errors.length === 0, errors);
  await browser.close();
}

const stages = { wallet: walletStage, launch: launchStage, trade: tradeStage, trackers: trackerStage, graduate: graduateStage, social: socialStage, media: mediaStage };
const only = process.argv[2];
for (const [name, run] of Object.entries(stages)) if (!only || only === name) await run();
console.log(failures ? `\n${failures} FAILED` : "\nall local items pass");
process.exitCode = failures ? 1 : 0;
