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
