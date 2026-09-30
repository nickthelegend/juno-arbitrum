# Juno on Arbitrum: end-to-end test plan

Every item is tested against the **live product**: the web app at
https://juno-arb-app.vercel.app in real Chrome (Claude in Chrome), the API at
https://juno-arb-api.vercel.app (called from that browser page, so CORS is
real), and the contracts on Arbitrum Sepolia (421614). "On-chain truth" means a
direct `cast call` / event read against the chain, independent of the API.

A PASS means the observed result equals the **Expected** column exactly, and
the browser console and network tab for that item show no errors (4xx/5xx
that the item itself expects are not errors). Status: PASS, FAIL (then fixed
and re-run), or UNTESTED (with the missing dependency named).

Reference data (on-chain, block ≥ 313703377):
- SMOKE: token `0x69f33cfa…82ce`, curve `0x7d4ceaa4…557b`, content post, ETH, creator = deployer `0x39d7…53b9`; 1 buy, 1 sell, fees claimed.
- jTSLA: token `0x8b884153…3fed`, curve `0x079fcf8e…4d3c`, tracker, USDC, feed TSLA mock `0x293c…d685`, band 100 bps; 1 buy ($500).
- GRAD: token `0xd2b84014…e8ec`, curve filled and graduated → pool `0x93fceb86…02ca`, position #3803.

## A. Platform and API infrastructure

| ID | Item | Expected |
|---|---|---|
| A1 | `GET /api/health` | 200; `ok:true`; postgres.ok, mongo.ok true; chain 421614 `deployed:true`, rpc.ok, indexer lag < 600 blocks after one read; faucet reported `ok:false` with "fund 0x4a04…" while the faucet holds < 0.03 ETH (truthful) |
| A2 | Unknown API path | 404 JSON `{"error":"No such API route"}` |
| A3 | CORS from the web origin | a `fetch` from juno-arb-app.vercel.app to any GET route succeeds (no CORS error); POST with JSON body passes preflight |
| A4 | `POST /api/juno/index` | without `x-juno-index-secret` → 401; with it → 200 `done:true`, `lag:0` |
| A5 | `GET /api/juno/index` | 200 status of the cursor: last indexed block per chain, equal to Postgres cursor |

## B. Read API vs on-chain truth

| ID | Item | Expected |
|---|---|---|
| B1 | `GET /coins?chainId=421614` | exactly the 3 launched coins (= number of `Launched` events); each symbol, quote, preset, creator equals the event; `priceQuote` equals `curve.currentPrice()` in quote units (±0.1%) |
| B2 | `GET /coins/{SMOKE}` | activity = the 2 on-chain `Trade` events (buy then sell, amounts equal); holders = deployer only with balance = `balanceOf`; `creatorFeesQuote` = `state().creatorFees` (0 after claim); explorer URLs point at sepolia.arbiscan.io for the right addresses |
| B3 | `GET /coins/{bad}` | invalid address → 400; a valid address that is not a Juno coin → 404 |
| B4 | `GET /feed` | items newest first; every trade item matches a `Trade` event (tx hash + log index); no item without an on-chain source |
| B5 | `GET /stocks` | AAPL, NVDA, TSLA; `price` = mock `latestRoundData.answer / 1e8`; `ageSeconds` = now − `updatedAt` (±60 s); `marketOpen` = age < 26 h; TSLA lists jTSLA as a tracker |
| B6 | `GET /depth?token={jTSLA}` | every ladder rung's `amountOut` equals `curve.quoteBuy(amountIn).tokensOut` for that size (±1e-9 relative); the rung past the band says so |
| B7 | `GET /leaderboard` | the deployer's trade count = its `Trade` events (4: SMOKE buy/sell, jTSLA buy, GRAD buy) |
| B8 | `GET /portfolio/{deployer}` | holdings = non-zero `balanceOf` for each Juno token; value = balance × current price |
| B9 | `GET /tx/balance?wallet=` | `eth` = `cast balance`; `usdc` = TestUSDC `balanceOf` / 1e6 |
| B10 | `GET /posts`, `GET /posts/{id}` | list returns stored posts (from DB, none invented); unknown id → 404 |
| B11 | `GET /likes`, `/comments`, `/profiles`, `/follow`, `/saved`, `/watchlist`, `/plans` | 200 with DB-backed data; invalid address params → 400 |
| B12 | `GET /api/ipfs/{cid}` | a pinned CID streams its bytes with the right content type; a malformed CID → 400 |
| B13 | `GET /faucet` | the faucet's address and real balance |

## C. Transaction builders (server-built, device-signed)

| ID | Item | Expected |
|---|---|---|
| C1 | `tx/swap` ETH buy | one step to the curve; calldata decodes to `buy(minOut, deadline)`; value = amount; minOut = quote × (1 − slippage); deadline ≈ now + 600 |
| C2 | `tx/swap` sell | calldata `sell(amountIn, minOut, deadline)`; no approve step |
| C3 | `tx/swap` USDC tracker buy | `approve` then `buyWithQuote` when allowance is short; a single `buyWithQuote` when it is not |
| C4 | band + quoteOnly | $500 visitor quote returns fee/impact/tokensOut; $9,500 → 400 `OutsideBand` with the message "…more than 1% above the stock…" |
| C5 | `tx/claim` | non-creator → 403 `NotCreator`; creator with 0 fees → 400 "Nothing to claim yet." |
| C6 | `tx/graduate` | graduated curve → 400 "This market moved to Uniswap."; an unfilled curve → 400 with a not-full reason |
| C7 | `tx/launch` | builds `factory.launch` for a post, with value 0 and the right preset/quote; invalid preset → 400 |
| C8 | `tx/record` | a real Juno trade tx → its events recorded (idempotent on repeat); a tx with no Juno logs → nothing recorded (no fake rows) |
| C9 | Real buy on Sepolia | steps from C1, signed by the deployer key and sent: receipt success; `Trade` event; indexed within one index pass; visible in the coin page's Activity in Chrome |
| C10 | Real sell on Sepolia | same as C9 for a sell |

## D. Social writes (must be authenticated) and media

| ID | Item | Expected |
|---|---|---|
| D1 | Name claim | valid EIP-191 signature → 200 and `GET /profiles` returns it; the name replaces `0x…` on the coin page in Chrome; wrong signer → 401; `issuedAt` older than 10 min → 400 |
| D2 | Comment | an authenticated wallet posts → 201, `GET /comments` returns it, and it shows in the coin page's Comments tab; **a request that claims another wallet without proof is refused (401)** |
| D3 | Like | authenticated like → count +1, repeat is idempotent, unlike → −1; **unauthenticated or spoofed wallet → 401** |
| D4 | Follow | authenticated follow/unfollow updates follower counts; **spoofed → 401** |
| D5 | Watchlist | authenticated add/remove persists; **spoofed → 401** |
| D6 | Plans | authenticated create / pause / delete persist; **spoofed → 401** |
| D7 | Posts | authenticated post persists and is returned by `/posts`; **spoofed → 401** |
| D8 | Upload + metadata | an authenticated upload pins to Pinata and returns a CID the IPFS route serves; metadata JSON pins and serves with ERC-721 fields; **anonymous → 401** |

## E. Web app in Chrome (visitor)

| ID | Item | Expected |
|---|---|---|
| E1 | Landing `/` | hero, "Arbitrum Sepolia · test ETH" chip, Get Started → `/social`; no console errors except none |
| E2 | Feed `/social` | one card per post coin (SMOKE, GRAD; trackers are not posts); price, "Bought by", graduation progress match B1/B2; GRAD shows "On Uniswap" |
| E3 | Reels `/reels` | no reels launched → the empty state, not an error |
| E4 | Trade › Stocks | 3 stocks with B5's prices, age, OPEN/CLOSED; jTSLA row with curve price, deviation, band |
| E5 | Trade › Memes | the content coins with prices matching B1 |
| E6 | Trade › Traders | leaderboard rows matching B7 |
| E7 | Coin page SMOKE | stats, chart or its "not enough trades" state, Activity (buy + sell), Holders, Comments, Details (addresses and Arbiscan links correct) |
| E8 | Coin page jTSLA | band card = B5 + curve price; Buy sheet signed out: $500 shows fee 1.25 USDC-ish / impact / receive; $9,500 shows the band refusal; button says "Sign in to trade" |
| E9 | Coin page GRAD | "Graduated · Trading on Uniswap"; the button opens the pool `0x93fc…02ca` |
| E10 | Trader page | `/trader/0x39d7…53b9` holdings and P&L match B8 |
| E11 | Post tab signed out | asks to sign in; no crash |
| E12 | Profile tab signed out | sign-in call to action; no wallet data shown |
| E13 | Unknown route / bad coin address | the not-found screen; a bad coin shows "not found", not a crash |
| E14 | Console + network | zero console errors and zero failed requests on E1–E13 |
| E15 | Sign in with email (Privy) | sheet opens; OTP → wallet created → Profile shows the address |

## G. Added in the second run (flows the first plan missed)

| ID | Item | Expected |
|---|---|---|
| G1 | Post detail `/post/{id}` | an existing post renders its body, author and time; an unknown id shows a not-found state (no crash, no console error) |
| G2 | Signed-out Follow | tapping Follow on a feed card opens the sign-in sheet; no request is sent |
| G3 | Signed-out "Sign in to trade" | tapping it in the buy sheet opens the sign-in sheet |
| G4 | Chart ranges | 1H / 1D / 1W / 1M / All each render (a line or the "not enough trades" note) with no console error |
| G5 | Copy address | copies the token address exactly (clipboard = the coin's address) |
| G6 | Leaderboard → trader | tapping the leaderboard row opens `/trader/{wallet}` for that wallet |
| G7 | Exact-out buy builder | `tx/swap` with `amountOut` builds `buyExactOut(tokensOut, maxIn, deadline)` with value = maxIn = quote × (1 + slippage) |
| G8 | Visitor sell quote | `quoteOnly` sell returns the proceeds; selling more than the curve has sold → refusal |
| G9 | Sell-side depth | `depth?side=sell` points equal `quoteSell` for those sizes |
| G10 | Sign-in sheet opens Privy | "Sign in" opens the email step; Privy's frame loads on this origin with no CSP/403 errors |

## F. Contracts and operations

| ID | Item | Expected |
|---|---|---|
| F1 | Source verification | factory, curve impl, tokens, TestUSDC, mocks = Sourcify exact match |
| F2 | Stylus reproducibility | `stylus-match.sh` MATCH locally and in CI |
| F3 | Band enforced on-chain | `eth_call` of `buyWithQuote(9500 USDC)` on jTSLA reverts `OutsideBand` |
| F4 | Stale feed | a buy with the feed older than `maxAge` reverts `MarketClosed`; a sell succeeds (fork test suite) |
| F5 | Contract suites | `forge test` all pass; `cargo test` all pass |
| F6 | Server suites | `vitest` unit all pass; `tsc` clean (server + app) |
| F7 | Feed keeper | `feeds` workflow run succeeds and writes only on 0.5% / 4 h |
| F8 | Index cron | `index` workflow with the secret → 200 |

## Results: run of 29 Sep 2026

Browsers: Claude in Chrome (A–E, re-verified after the fixes) and a
Playwright Chromium run of the same pages while the Chrome host was down
(`scripts/demo/e2e-ui.mjs`). API items are re-runnable with
`scripts/e2e-api.ts` (36 checks); keyed on-chain items with `scripts/e2e-live.ts`.

| ID | Status | Evidence / what was fixed |
|---|---|---|
| A1 | PASS | health 200, pg/mongo/rpc ok; faucet now reported `ok:false` with the address to fund (was `ok:true` at 0 ETH, fixed) |
| A2 | PASS | 404 JSON |
| A3 | PASS | CORS `*`; preflight now allows `authorization` (added with sessions) |
| A4 | PASS | 401 without the secret; cron runs with it |
| A5 | PASS | cursor status, 3 curves |
| B1 | PASS | 3 coins = 3 `Launched`; prices = `currentPrice()` |
| B2 | PASS | activity = `Trade` events; holder balance = `balanceOf`; Arbiscan links right |
| B3 | PASS | 400 / 404 |
| B4 | PASS | trades = `Trade` events, posts = stored posts, newest first (the first check wrongly expected trades only) |
| B5 | PASS | price, updatedAt, age = the feed's round |
| B6 | FAIL → PASS | the ladder quoted sizes the contract refuses; points now carry `allowed` (the curve's `bandOk && marketOpen`) and the chart marks them ("From about $9.39k the contract refuses the buy") |
| B7 | PASS | trades = `Trade` events |
| B8 | PASS | positions = `balanceOf` |
| B9 | PASS | = `cast balance` / USDC `balanceOf` |
| B10 | PASS | |
| B11 | FAIL → PASS | batch lookups dropped bad addresses silently; now 400 (`addressList`) |
| B12 | FAIL → PASS | a pinned PNG streams byte-exact; error responses lacked CORS (fixed) |
| B13 | PASS | |
| C1 | FAIL → PASS | refused by a flat 0.0005 ETH reserve (50× real gas); builders now check value + estimated gas at max fee; app blocker removed |
| C2 | FAIL → PASS | same fix |
| C3 | PASS | approve + `buyWithQuote` for a wallet with USDC and no allowance (keeper mint); single step with allowance |
| C4 | PASS | visitor quote; refusal is `200 {refusal}` for visitors (no console error), 400 for signed-in builds |
| C5 | PASS | 403 non-creator; creator gets a claim step |
| C6 | PASS | graduated / not full |
| C7 | PASS | `factory.launch` calldata decoded (built for a funded address; the deployer is correctly refused for want of ~0.0003 ETH) |
| C8 | PASS | real trade recorded, idempotent; non-Juno tx records nothing; bad hash 400 |
| C9 | PASS | real buys: 0xa3b687f0…, 0x3e19f817… |
| C10 | PASS | real sells: 0xeeae574b…, 0xf766dffe… |
| D1 | FAIL → PASS | wrong signer was 400, now 401 `BadSignature`; `juno_team` shows in the feed, coin and trader pages |
| D2–D7 | FAIL → PASS | **any caller could write as any wallet** (likes, comments, follows, watchlist, plans, posts). Wallet sessions added (EIP-191 once → 7-day HMAC token); spoof → 403, anonymous → 401; verified in Chrome with a browser-generated wallet |
| D8 | FAIL → PASS | **uploads had never worked in production** (ffmpeg/sharp shipped for macOS); linux-arm64 binaries now shipped, ffmpeg lazy; uploads and pins now require a session |
| E1 | PASS | |
| E2 | PASS | names resolve after `/profiles` |
| E3 | PASS | empty state |
| E4 | FAIL → PASS | the app called Sepolia's mirrored feeds plain "Chainlink"; now "Chainlink, mirrored" with the disclosure |
| E5, E6 | PASS | |
| E7 | PASS | activity, holders, comments (the signed test comment appeared under its claimed name), details |
| E8 | FAIL → PASS | visitors got no quote (fixed: `quoteOnly`); $500 quote and $9,500 refusal both shown |
| E9 | FAIL → PASS | opened a non-existent Uniswap page for Sepolia; now the pool on Arbiscan |
| E10 | PASS | |
| E11, E12 | PASS | |
| E13 | FAIL → PASS | a malformed address hit the API (two 400s in the console); now answered locally. An unknown address gets the API's correct 404 |
| E14 | PASS (app) | zero console errors and zero failed requests from the app on every page. Removed: Coinbase/Base SDK self-probes (aborted HEADs on every page), the visitor-quote 400. Remaining, all Privy's: its embedded-wallet frame is refused on this origin (+ its CSP report and a 403 from Privy analytics) until the origin is allowed in the Privy dashboard |
| E15 | UNTESTED | needs the web origin allowed in Privy, and an email inbox for the one-time code |
| F1 | PASS | 9 contracts exact-match on Sourcify |
| F2 | PASS | stylus-match MATCH locally and in CI |
| F3 | PASS | `eth_call` reverts `OutsideBand(361778572, 357535000, 100)` |
| F4 | PASS | `test_staleFeedBlocksBuysNotSells` on the Arbitrum One fork |
| F5 | PASS | forge 31/31, cargo 9/9 |
| F6 | PASS | vitest 143/143; tsc clean (server, app, scripts) |
| F7 | PASS | feeds workflow success |
| F8 | PASS | index cron success on schedule |

Test data written to production during the run (the browser test wallet's 3
posts, 1 comment and name) was deleted afterwards; the scripted runs undo
their own writes.

## Results: second run, 29 Sep 2026 (US market hours)

Everything above was re-run from the top (API battery 36/36, all 15 pages
clean, keyed on-chain checks incl. a third real buy and sell, contract suites),
plus the G items. Fixes made in this run:

| ID | Status | Evidence / what was fixed |
|---|---|---|
| E14 / G10 | FAIL → PASS | Privy still refused its wallet frame after the origin was allowed: the web build passed the **mobile** app client id, whose allowlist lacks the web origin. The web build now uses the app's default client (`EXPO_PUBLIC_PRIVY_WEB_CLIENT_ID` to override). Every page: zero Privy errors; the sign-in sheet reaches the email step |
| E13 | FAIL → PASS | the unknown-coin page logged the API's 404; the app now asks `?lookup=1` and gets `200 {notFound:true}` (default API stays 404) |
| G1 | FAIL → PASS | a real post renders from Postgres; an unknown post id logged a 404 — same lookup fix |
| G2 | FAIL → PASS | signed-out Follow (and the heart) switched to "Following"/liked before anyone signed in; the optimistic update now waits for the wallet. Also: a write made straight after sign-in could fail before the session signer registered — it now waits for it |
| G3 | PASS | "Sign in to trade" opens the sign-in sheet |
| G4 | PASS (fix: a11y) | ranges switch (past hour/day/week/month/all time); the range and tab buttons had no accessible names — labelled |
| G5 | PASS | clipboard = the token address; "Copied" |
| G6 | PASS | leaderboard row → `/trader/0x39d7…53b9` |
| G7 | PASS | `buyExactOut(1000e18, maxIn, deadline)`, value = maxIn = quote × 1.01 |
| G8 | PASS | visitor sell quote = `quoteSell`; over-sell → refusal |
| G9 | PASS | sell-side depth = `quoteSell` |
| F7 | FAIL → PASS | GitHub's scheduler did not run the feed keeper for a whole trading morning: the Sepolia mirrors were 21 h old (5 h from reading "market closed"). The API now mirrors the real Arbitrum One feeds on read (`lib/juno/mirror-feeds.ts`, keeper key on Vercel, 3 unit tests); the cron stays as a backstop |

Note on the browser: Claude in Chrome's element clicks did not always reach
React Native Web's pressables (range pills, Buy); the same buttons respond to
real mouse input in Google Chrome (Playwright, `channel: "chrome"`, raw mouse
down/up), which is how G3/G4/G6 were confirmed. Page content, console and
network for every item were read through Claude in Chrome.

## L. Signed-in flows on a local Arbitrum node (30 Sep 2026)

Everything a signed-in user does, run through the web app on a local Nitro
dev node (chain 412346, `scripts/localnet/up.sh`: the same contracts
including the Stylus `CurveMath`, WETH and a real Uniswap v3 factory and
position manager, three feeds, Multicall3). The node stands in for Arbitrum
Sepolia while the deployer has no test ETH. Stack: local API (`next dev` with
`server/.env.localnet`, local Postgres and Mongo, real Pinata), local web
build with `EXPO_PUBLIC_WALLET=injected`. That is a browser (EIP-1193) wallet
in place of Privy, and it signs every transaction and message for real.
`node scripts/localnet/e2e.mjs` drives Chromium with three fresh wallets
(alice, bob, carol). Each UI step is then checked against the chain and the
API, and every stage checks that the console and network are clean.

Result of the fresh, full run: **40/40 PASS.**

| ID | Flow | Checked against |
|---|---|---|
| L1 | Connect a browser wallet | profile shows the address |
| L2 | Faucet from the profile; a second request; the card after a drip | 0.02 ETH + 1,000 USDC on-chain; 429 with the wait; "Faucet used today" + the wait, before any request |
| L3 | Claim a name (signed) | stored, shown |
| L4 | Launch a photo post | IPFS pins, launch tx, curve, listed, caption posted as the creator's post, in the feed |
| L5 | Launch a reel | video + distinct poster, `media.kind: "video"`, in Reels |
| L6 | Buy 0.002 ETH from the sheet, with a comment | tokens held, activity row, comment stored, receipt links the chain's explorer |
| L7 | Sell 50%, then 100% | half (rounded down) leaves; 100% leaves exactly 0 |
| L8 | Like and follow from the feed | stored against the wallet's session |
| L9 | Creator claims fees | offered to the creator only, paid, rewards 0 |
| L10 | Tracker: Trade tab → jTSLA, spend 50 USDC | "Approve USDC → Buy", USDC −50, tokens held; a 20,000 USDC buy is refused in words before signing, Buy disabled (`aria-disabled`) |
| L11 | Stock feed stale (keeper stamps it 27 h old) | coin offers "Sell · market closed"; sell 100% settles in USDC; API refusal `MarketClosed` |
| L12 | Fill a post's curve from the sheet | auto-graduates: Uniswap v3 pool with liquidity; "Trading on Uniswap ↗" opens the pool on the explorer; the curve refuses more trades |
| L13 | Watch, price alert, weekly plan, "Put in" | watchlist, alert at the typed price, plan stored, the contribution is a real buy counted in the plan |
| L14 | Caption → thread → reply | reply stored and shown |
| L15 | Creator profile; holder's portfolio | name, follow state, no sold-out rows; graduated coin valued and on the profile |

Found and fixed while doing it:

| Where | Problem | Fix |
|---|---|---|
| reels | a reel's metadata had the video as `image` and no `animation_url` (the app sent the poster as `imageUrl`/`mimeType`), so reels were listed as photos and missing from Reels | the app sends `mediaUrl`/`mimeType`/`posterUrl`; the route also reads the old field names |
| upload | every reel upload failed on ffprobe 4.4 (no `stream_side_data` section) | read rotation from `side_data_list` or `tags.rotate` |
| sell sheet | the 50% preset rounded to six figures, and 100% could round above the holding and be refused | partial presets round down; 100% is the whole holding; the server takes a sell within a billionth of the balance (either side) as "everything", so no dust remains (2 unit tests) |
| trade sheet | a signed-in out-of-band quote was a 400 in the network log | `refusalAsAnswer: true` → `200 {refusal}`, like visitor quotes |
| kit `Button` | disabled buttons had no `aria-disabled` on the web (Pressable reads `disabled`, not `accessibilityState`) | pass `disabled` |
| labels | "View on Arbiscan" etc. on chains whose explorer is not Arbiscan; "Sign in with your email" with a browser wallet | `EXPLORER_NAME`; copy follows the wallet |
| threads | text posts were never written by the app and their thread screen was unreachable | the launch caption is posted as the creator's post; feed cards link "Reply / N replies" to the thread |
| holdings | sold-out positions listed as "0 jTSLA · $0" | holdings list only what is held (realised P&L stays in the totals) |
| faucet | the card offered the faucet to a wallet that had used it, and the refusal was a 429 | `GET /api/juno/faucet?wallet=` says whether it may drip and the wait; the card shows it instead of asking |

## M. Claude in Chrome pass, then a full re-run (1 Oct 2026)

The local stack was rebuilt from nothing (`up.sh --fresh`), then the real
Chrome was driven through Claude in Chrome against `http://localhost:8091`.
Signed-in steps used a browser wallet put on `window.ethereum` for localhost,
with a key made for this run that exists only on the local chain. It signs
and sends every transaction itself, as MetaMask with a dev key would. The
native file dialog cannot be driven, so the photo went into the picker's own
`<input type=file>` through Chrome's upload tool. Console and network were
read after every item.

| ID | Item (real Chrome) | Result |
|---|---|---|
| M1 | Empty states: feed, reels, trade (three trackers), profile signed out, composer | PASS |
| M2 | Bad links: `/coin/0xbad`, unknown coin, unknown post, bad wallet, empty wallet, unknown route | PASS (each says so; zero console errors; all 200) |
| M3 | Visitor quote on jTSLA: 50 USDC → 0.140123 jTSLA, fee 0.875 USDC | PASS (equals `quoteBuy(50e6)` on-chain) |
| M4 | Visitor 20,000 USDC buy | PASS (refused in words) |
| M5 | Connect, faucet, name claim | FAIL → PASS (the faucet 500'd: see fixes) |
| M6 | Launch a photo post (thin-name preset) with a 1-char ticker first | PASS (validation, then launched; caption posted) |
| M7 | Buy 0.001 ETH; creator claims fees; sell 100% | FAIL → PASS (receipt showed the quote, not the fill) |
| M8 | Tracker: "Sign in to trade", then 25 USDC Approve → Buy | FAIL → PASS (sign-in opened invisibly) |
| M9 | Receipt's explorer link | PASS (local explorer shows the USDC in, Trade event, tokens out) |
| M10 | Watch | PASS |

Found and fixed:

| Where | Problem | Fix |
|---|---|---|
| localnet | Nitro `--dev` kept recent state in memory: a reboot rolled the chain back to block 78 while the databases kept later rows. A SIGKILL leaves the sequencer out of step ("wrong msgIdx"), so every transaction fails, including the faucet's 500 | archive mode (state written every block); `up.sh` checks that the node accepts a transaction and says to use `--fresh` if not; `--fresh` recreates the chain and the databases together; a plain `up.sh` restores without redeploying. Checked: a graceful stop keeps blocks and sequencing |
| localnet | node, Postgres (toy password) and Mongo (no auth) listened on every interface | published on 127.0.0.1 only, and `up.sh` creates all three containers |
| app | reads and writes carried no `chainId`, so one API serving several chains answered with its default (an Arbitrum One build would have read Sepolia) | every `/api/juno` call carries the build's chain |
| trade sheet | the Done line repeated the quote; on a fresh coin the fee falls by the second, so 44.68M filled where 44.19M was quoted | the line reads the curve's `Trade` event from the receipt; plan contributions count the amount really spent |
| trade sheet | "Sign in to trade" opened the sign-in sheet beneath the trade sheet's Modal (invisible) | the trade sheet closes first |
| coin page, trade tab, sheet | a new tracker at -1.0000003% read "-1.00%" and "outside ±1%" | inside/outside judged at the precision shown |
| copy | "Privy creates a wallet…" and "Privy wallet" with a browser wallet | follows the wallet |

Then everything again, from scratch: `node scripts/localnet/e2e.mjs` with
fresh wallets: **41/41 PASS**. That includes the refused-faucet path, since
this network's third drip went to the Chrome wallet. Also run: server unit
tests 148/148, Foundry 31/31 (including Arbitrum One fork tests), Stylus
`cargo test` 9/9, and app `tsc`, all green.

Not testable here, and why:
- **Privy email sign-in:** it needs a real inbox and a code, and sending one
  on the user's behalf is off limits. The local web build uses the browser
  wallet path. The Privy web build was checked up to the email step in the
  second run (E14).
- **Native Android and iOS:** no device run in this pass. The same app code
  was typechecked. The APK and iOS builds need a rebuild to carry these fixes.
- **Arbitrum Sepolia and One:** deferred until deployment. The deployer has no
  test ETH, and mainnet is the user's to fund and run.
