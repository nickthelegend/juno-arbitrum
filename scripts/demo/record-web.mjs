/**
 * Record the film's phone chapters from the live web app at iPhone size.
 *
 *   node scripts/demo/record-web.mjs .juno/video/raw [c01,c04]
 *
 * Each take is a real session against https://juno-arb-app.vercel.app and the
 * Arbitrum Sepolia contracts behind it: nothing is staged. Writes
 * <out>/<name>.mp4 (the bare screen, 393x852 CSS px), trimmed to start once the
 * page has loaded. Needs Playwright and its chrome-headless-shell (system
 * Chrome's headless mode records the wrong viewport on mobile emulation);
 * JUNO_CHROMIUM points at the binary.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { chromium, devices } from "playwright";

const APP = process.env.JUNO_APP_URL ?? "https://juno-arb-app.vercel.app";
const OUT = process.argv[2];
const only = process.argv[3] ? new Set(process.argv[3].split(",")) : null;
const SMOKE = "0x69f33cfa02073a1387dd25d0b45b25723acd82ce";
const TSLA = "0x8b884153da62882e9f4484c7408e4ab3124f3fed";
const GRAD = "0xd2b8401420b2ef285ddea9e1c4b7ddf0c1c5e8ec";
mkdirSync(OUT, { recursive: true });

/** Eased scroll of the page's main scroller (React Native web scrolls a div). */
async function scroll(page, dy, ms = 1400) {
  await page.evaluate(
    ([dy, ms]) =>
      new Promise((done) => {
        const el = [...document.querySelectorAll("div")]
          .filter((d) => d.scrollHeight > d.clientHeight + 20 && /auto|scroll/.test(getComputedStyle(d).overflowY))
          .sort((a, b) => b.clientHeight - a.clientHeight)[0];
        if (!el) return done();
        const from = el.scrollTop;
        const t0 = performance.now();
        const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
        const step = (now) => {
          const t = Math.min(1, (now - t0) / ms);
          el.scrollTop = from + dy * ease(t);
          if (t < 1) requestAnimationFrame(step);
          else done();
        };
        requestAnimationFrame(step);
      }),
    [dy, ms],
  );
}

/** A soft touch marker where the "finger" lands, then the real click. */
async function tap(page, locator) {
  const box = await locator.boundingBox();
  if (!box) throw new Error("tap target not visible");
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.evaluate(([x, y]) => {
    const dot = document.createElement("div");
    dot.style.cssText = `position:fixed;left:${x - 22}px;top:${y - 22}px;width:44px;height:44px;border-radius:22px;background:rgba(18,21,14,0.28);border:2px solid rgba(255,255,255,0.7);z-index:99999;pointer-events:none;transition:transform .45s ease-out,opacity .45s ease-out`;
    document.body.appendChild(dot);
    requestAnimationFrame(() => requestAnimationFrame(() => { dot.style.transform = "scale(1.6)"; dot.style.opacity = "0"; }));
    setTimeout(() => dot.remove(), 600);
  }, [x, y]);
  await page.waitForTimeout(180);
  await page.mouse.click(x, y);
}

async function keypad(page, digits) {
  for (const d of digits) {
    await tap(page, page.getByText(d, { exact: true }).last());
    await page.waitForTimeout(260);
  }
}

async function clear(page, n) {
  for (let i = 0; i < n; i++) {
    await tap(page, page.getByText("⌫", { exact: true }));
    await page.waitForTimeout(160);
  }
}

const TAKES = {
  // c01: the feed, live
  "01-feed": async (page) => {
    await page.goto(`${APP}/social`, { waitUntil: "networkidle" });
    await page.waitForTimeout(2500);
    return async () => {
      await page.waitForTimeout(1500);
      await scroll(page, 420, 2200);
      await page.waitForTimeout(1200);
      await scroll(page, 520, 2400);
      await page.waitForTimeout(1500);
      await scroll(page, -940, 2200);
      await page.waitForTimeout(1200);
    };
  },
  // c02: a post's market, with the creator's rewards and its real trades
  "02-creator": async (page) => {
    await page.goto(`${APP}/coin/${SMOKE}`, { waitUntil: "networkidle" });
    await page.waitForTimeout(2500);
    return async () => {
      await page.waitForTimeout(1500);
      await scroll(page, 330, 2000);
      await page.waitForTimeout(2500);
      await scroll(page, 520, 2200);
      await page.waitForTimeout(2500);
    };
  },
  // c03: stocks held to Chainlink
  "03-stocks": async (page) => {
    await page.goto(`${APP}/trade`, { waitUntil: "networkidle" });
    await page.waitForTimeout(2500);
    return async () => {
      await page.waitForTimeout(2800);
      await scroll(page, 460, 2600);
      await page.waitForTimeout(2800);
      await scroll(page, 560, 2600);
      await page.waitForTimeout(3800);
    };
  },
  // c04: the tracker's band card, then the sheet quoting $500 and $9,500
  "04-band": async (page) => {
    await page.goto(`${APP}/coin/${TSLA}`, { waitUntil: "networkidle" });
    await page.waitForTimeout(2500);
    return async () => {
      await page.waitForTimeout(1200);
      await scroll(page, 430, 2000);
      await page.waitForTimeout(2600);
      await tap(page, page.getByText("Buy", { exact: true }).last());
      await page.waitForTimeout(1400);
      await keypad(page, "500");
      await page.waitForTimeout(3200);
      await clear(page, 3);
      await keypad(page, "9500");
      await page.waitForTimeout(4200);
    };
  },
  // c06: a curve that filled and graduated into Uniswap v3
  "06-graduated": async (page) => {
    await page.goto(`${APP}/coin/${GRAD}`, { waitUntil: "networkidle" });
    await page.waitForTimeout(2500);
    return async () => {
      await page.waitForTimeout(2500);
      await scroll(page, 380, 2000);
      await page.waitForTimeout(3000);
      await tap(page, page.getByText("Holders", { exact: true }).first());
      await page.waitForTimeout(3000);
      await tap(page, page.getByText("Details", { exact: true }).first());
      await page.waitForTimeout(4500);
    };
  },
};

const browser = await chromium.launch({
  executablePath:
    process.env.JUNO_CHROMIUM ??
    join(homedir(), "Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell"),
});
for (const [name, take] of Object.entries(TAKES)) {
  if (only && !only.has(name.slice(0, 2)) && !only.has(name)) continue;
  const dir = join(OUT, `.rec-${name}`);
  rmSync(dir, { recursive: true, force: true });
  const context = await browser.newContext({
    ...devices["iPhone 15 Pro"],
    // The whole screen, like the simulator (the preset's viewport leaves out
    // Safari's bars); 1x, because the recorder captures CSS pixels.
    viewport: { width: 393, height: 852 },
    screen: { width: 393, height: 852 },
    deviceScaleFactor: 1,
    recordVideo: { dir, size: { width: 393, height: 852 } },
  });
  const page = await context.newPage();
  const started = Date.now();
  const play = await take(page);
  const trimFrom = (Date.now() - started) / 1000;
  await play();
  await context.close();
  const webm = join(dir, readdirSync(dir).find((f) => f.endsWith(".webm")));
  execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-ss", trimFrom.toFixed(2), "-i", webm, "-r", "30", "-c:v", "libx264", "-crf", "16", "-pix_fmt", "yuv420p", join(OUT, `${name}.mp4`)]);
  rmSync(dir, { recursive: true, force: true });
  console.log(name, "from", trimFrom.toFixed(1) + "s");
}
await browser.close();
