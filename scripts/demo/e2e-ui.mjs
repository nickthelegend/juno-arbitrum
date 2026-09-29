/**
 * The web app's visitor flows (docs/TEST-PLAN.md E-series), against the live
 * site in a real Chromium: each page's text, every console error, and every
 * failed or non-2xx request. Prints one JSON report.
 *
 *   node scripts/demo/e2e-ui.mjs
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { chromium, devices } from "playwright";

const APP = process.env.JUNO_APP_URL ?? "https://juno-arb-app.vercel.app";
const SMOKE = "0x69f33cfa02073a1387dd25d0b45b25723acd82ce";
const TSLA = "0x8b884153da62882e9f4484c7408e4ab3124f3fed";
const GRAD = "0xd2b8401420b2ef285ddea9e1c4b7ddf0c1c5e8ec";
const DEPLOYER = "0x39d73f1b3662a6120ebeafede5762809ba8f53b9";

const browser = await chromium.launch({
  executablePath:
    process.env.JUNO_CHROMIUM ??
    join(homedir(), "Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell"),
});
const context = await browser.newContext({ ...devices["iPhone 15 Pro"], viewport: { width: 393, height: 852 } });

/** Privy's embedded-wallet frame is refused on this origin until it is allowed in the Privy dashboard; counted, not hidden. */
const privyFrame = (text) => /auth\.privy\.io|frame-ancestors|csp-report\.browser-intake-datadoghq/.test(text);

const report = {};
async function visit(id, path, act) {
  const page = await context.newPage();
  const errors = [];
  const failed = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text().slice(0, 200)));
  page.on("pageerror", (e) => errors.push(`pageerror: ${String(e).slice(0, 200)}`));
  page.on("requestfailed", (r) => failed.push(`${r.failure()?.errorText} ${r.url().slice(0, 120)}`));
  page.on("response", (r) => r.status() >= 400 && failed.push(`${r.status()} ${r.request().method()} ${r.url().slice(0, 120)}`));
  await page.goto(`${APP}${path}`, { waitUntil: "networkidle", timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(2500);
  const result = { url: page.url().replace(APP, "") };
  try {
    if (act) Object.assign(result, await act(page));
  } catch (error) {
    result.actError = String(error).slice(0, 300);
  }
  result.text = result.text ?? (await page.locator("body").innerText()).replace(/\n+/g, " / ").slice(0, 700);
  result.consoleErrors = errors.filter((e) => !privyFrame(e));
  result.failedRequests = failed.filter((f) => !privyFrame(f));
  result.privyNoise = errors.concat(failed).filter(privyFrame);
  report[id] = result;
  await page.close();
}

const text = async (page) => (await page.locator("body").innerText()).replace(/\n+/g, " / ");
async function tap(page, name) {
  await page.getByText(name, { exact: true }).first().click({ timeout: 10000 });
  await page.waitForTimeout(1500);
}

await visit("E1_landing", "/", async (page) => {
  const before = await text(page);
  await tap(page, "Get Started");
  await page.waitForTimeout(2000);
  return { landing: before.slice(0, 200), after: page.url().replace(APP, "") };
});
await visit("E2_feed", "/social");
await visit("E3_reels", "/reels", async (page) => {
  await page.waitForTimeout(6000);
  return {};
});
await visit("E4_stocks", "/trade");
await visit("E5_memes", "/trade", async (page) => {
  await tap(page, "Memes");
  return { text: (await text(page)).slice(0, 600) };
});
await visit("E6_traders", "/trade", async (page) => {
  await tap(page, "Traders");
  await page.waitForTimeout(2500);
  return { text: (await text(page)).slice(0, 400) };
});
await visit("E7_smoke", `/coin/${SMOKE}`, async (page) => {
  await page.waitForTimeout(2500);
  const main = await text(page);
  await tap(page, "Details");
  const details = await text(page);
  const at = details.lastIndexOf("Details");
  const links = await page.$$eval("a[href]", (as) => as.map((a) => a.getAttribute("href")).filter((h) => h && h.includes("arbiscan")));
  return { text: main.slice(0, 500), details: details.slice(at, at + 700), links };
});
await visit("E8_tracker", `/coin/${TSLA}`, async (page) => {
  await page.waitForTimeout(3500);
  const main = await text(page);
  await page.getByText("Buy", { exact: true }).last().click();
  await page.waitForTimeout(1500);
  for (const k of "500") await page.getByText(k, { exact: true }).last().click();
  await page.waitForTimeout(3500);
  const q500 = await text(page);
  for (let i = 0; i < 3; i++) await page.getByText("⌫", { exact: true }).click();
  for (const k of "9500") await page.getByText(k, { exact: true }).last().click();
  await page.waitForTimeout(3500);
  const q9500 = await text(page);
  const cut = (t) => t.slice(t.indexOf("Trading fee"), t.indexOf("Trading fee") + 260);
  const band = main.indexOf("TSLA ·");
  const depth = main.indexOf("What a buy");
  return { text: main.slice(band, band + 600), depth: main.slice(depth, depth + 400), quote500: cut(q500), quote9500: cut(q9500) };
});
await visit("E9_graduated", `/coin/${GRAD}`, async (page) => {
  const main = await text(page);
  const [popup] = await Promise.all([
    page.waitForEvent("popup", { timeout: 8000 }).catch(() => null),
    page.getByText("Trading on Uniswap ↗", { exact: true }).last().click(),
  ]);
  return { text: main.slice(0, 400), opens: popup ? popup.url() : null };
});
await visit("E10_trader", `/trader/${DEPLOYER}`, async (page) => {
  await page.waitForTimeout(4000);
  return {};
});
await visit("E11_post_signed_out", "/post");
await visit("E12_profile_signed_out", "/profile");
await visit("E13_unknown_route", "/no-such-page");
await visit("E13_bad_coin", "/coin/0xnotanaddress");
await visit("E13_unknown_coin", "/coin/0x000000000000000000000000000000000000dead", async (page) => {
  await page.waitForTimeout(3000);
  return {};
});

await browser.close();
console.log(JSON.stringify(report, null, 1));
