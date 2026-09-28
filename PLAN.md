# Juno on Arbitrum — Execution Plan

Arbitrum Open House Singapore, online Buildathon. Written 28 Sep 2026.
**Submit by Sat 3 Oct, night (IST). Hard deadline assumed Sun 4 Oct 23:59 SGT (15:59 UTC, 21:29 IST).**

This document is self-contained. A builder agent should be able to execute it
without the conversation that produced it. Source of the port is the Solana
Juno repo at `/Volumes/Extreme SSD/Projects/zorr-solana` (branch `juno`,
release v1.1.0), referred to below as **the Solana repo**.

---

## Status — 29 Sep 2026 (execution run)

| Phase | Status | Evidence |
|---|---|---|
| 1 Setup | DONE | repo github.com/nickthelegend/juno-arbitrum; Foundry + OZ 5.4 + Chainlink; `cargo stylus` 0.10.9; deployer `0x39D7…53B9`, faucet `0x4A04…D6DB` (keys in .env only); external addresses verified on-chain |
| 2 Contracts | DONE | `forge test`: 31 pass (Arbitrum One fork) + 4 invariants × 8,192 calls; coverage JunoCurve 97%, Factory 99%, Token 100%; Slither triaged (docs/SECURITY.md); Stylus `cargo test --lib` 9 pass, `cargo stylus check` OK (20.5 KB) |
| 3 Sepolia deploy | DONE | Stylus CurveMath `0x5125…4f37`, factory `0xBc89…E87a` (block 313703377). Proof in docs/sepolia-proof.log: launch, buy, sell, claim, TSLA tracker buy, `OutsideBand(361.67, 357.54, 1%)`, and a post filled + graduated into Uniswap v3 (pool `0x93fC…02CA`, position #3803). Diff test Stylus ≡ CurveMathRef on 720 calls. Verification: Sourcify exact match for every Solidity contract (`scripts/verify.sh`), Blockscout for factory + curve; Stylus initcode rebuilt byte-identical (`scripts/stylus-match.sh`, CI). Arbiscan needs `ARBISCAN_API_KEY` (empty in .env). Feed keeper on GitHub Actions with its own key `0xC45E…59dC` (owns only the mocks) |
| 4 Server | DONE | 132 unit + 13 integration tests (Sepolia fork); live on Vercel https://juno-arb-api.vercel.app with DB/Mongo/Pinata/faucet secrets set, `/api/health` ok, index route requires `JUNO_INDEX_SECRET` (cron authenticated). Faucet wallet `0x4A04…D6DB` holds 0 ETH → faucet answers 503 until funded |
| 5 App | DONE (web sign-in blocked on Privy origin) | tsc clean; web live (feed, stocks, tracker band card, graduated state verified in the browser, docs/qa/); iOS Simulator release build launches; APK built. Web sign-in blocked until `https://juno-arb-app.vercel.app` is an allowed origin in Privy |
| 6 Demo data | BLOCKED — deployer holds 0.00007 test ETH, faucet 0 | `cd server && npm run demo` ran on the fork (5 wallets, 6 posts/reels, 3 trackers, 28 trades, 1 graduation); needs ~0.1 Arbitrum Sepolia ETH on the deployer or faucet. The Sepolia graduation (T6.2) is already done |
| 7 Arbitrum One proof | USER ACTION | `CHAIN=one bash scripts/deploy.sh` then `npx tsx scripts/mainnet-proof.ts` (asks before each tx; ~0.01 ETH + 2 USDC) |
| 8 Deliverables | PARTIAL | README (addresses, verification, ops), deck, GitHub release v0.1.0 (APK + iOS Simulator zip + SHA256SUMS), QA screenshots in docs/qa. Film tooling ported with Arbitrum narration and a shot list (docs/FILM.md); recording blocked on demo data + a Privy sign-in; captions need an ElevenLabs key |

Changes from the plan made during execution:
- API hosted on **Vercel** (user request), not Railway; indexing runs on read
  (after the response) plus a GitHub Actions cron every 5 minutes.
- Tracker staleness `maxAge` = **26 h** (Chainlink equity feeds have a 24 h
  heartbeat; a weekend now reads as market closed).
- Demo tracker shape: 100 tokens, 0.99× → 1.04× the stock, 1% band — so the
  top of the curve opens only as the stock rises and a ~$9.5k buy reverts.
- Sepolia trackers are quoted in Juno's faucet-mintable **Test USDC**; Arbitrum One uses Circle USDC.

## 1. Executive summary

Juno is a social app where every photo or reel is its own market: posting it
launches a bonding curve, people buy into the post as they scroll, and the
creator earns the trading fees. Juno also issues **stock trackers** — curves
priced against a real stock through a Chainlink feed.

This plan ports Juno from Solana (Meteora DBC) to **Arbitrum** with its own
contracts:

- **Solidity** launchpad: a factory that creates an ERC-20 plus a curve per post,
  decaying trading fees, a creator fee share, creator claim, and graduation into
  a **Uniswap v3** pool.
- **Stylus (Rust)** curve maths: the 16-segment piecewise curve that prices every
  buy and sell, called from Solidity. This is the Arbitrum-native component.
- **Stock trackers enforced on-chain**: a `tight-nav` curve reads Chainlink's
  TSLA/USD (etc.) feed and **reverts any buy that would push its price outside
  the band**. Buys are blocked when the feed is stale; sells are never blocked.
- **Privy embedded EVM wallets** on iOS, Android and web.

The app and demo run on **Arbitrum Sepolia**. The same contracts are deployed to
**Arbitrum One** for a small funded mainnet proof (one post curve, one TSLA
tracker against the real feed). Everything lives in a **new repo** with **new
deployments**, so the STOCKLANA submission stays untouched.

## 2. Vision, problem, target users

- **Problem.** Creators are paid by platforms, late, in ad money. The fans who
  found them first get nothing. Tokenized stocks exist on Arbitrum but nothing
  lets a community issue a product that tracks one with the price held to a band
  by the contract itself.
- **Vision.** Every post is a market. Early believers own a piece of it; creators
  earn every trade. The same curve machinery issues stock trackers with the band
  enforced on-chain.
- **Target users.**
  1. Creators who post photos and reels and want to earn from attention directly.
  2. Fans and traders who want early exposure to posts they believe in.
  3. Stock-curious crypto users who want dollar-priced trackers of TSLA, NVDA,
     AAPL on Arbitrum, held honest by Chainlink.

## 3. Goals and definitions of done

**Product done**
- A new user signs in with email, gets a wallet, funds it from the faucet,
  claims a name, buys a post, likes and comments, and posts their own photo or
  reel, which becomes a live curve they can see in the feed.
- A creator sees their accrued fees and claims them.
- A stock tracker shows the Chainlink price, the curve price and the band. A buy
  that would breach the band is refused **by the contract**, with a clear
  message in the app. When the market is closed the app says so and buys are
  blocked, while sells still work.
- A curve that fills graduates into a Uniswap v3 pool, and the app links to it.

**Technical done**
- The contracts are deployed and verified on Arbitrum Sepolia and on Arbitrum
  One: `JunoFactory`, `JunoCurve` (clones), `JunoToken`, and the Stylus
  `CurveMath`.
- Foundry tests cover:
  - every preset's buy, sell and exact-out paths;
  - fee decay, creator fee accrual and claim;
  - graduation;
  - band enforcement and staleness;
  - differential tests that compare the Stylus maths with a Solidity reference
    model.
- The server indexes contract events into Postgres, so the feed, charts,
  portfolio and leaderboard read from real on-chain data.
- No Solana code, dependency or copy remains in the repo.

**Demo done**
- A demo film of at most 5 minutes, in the same style as the STOCKLANA film:
  HyperFrames, iOS Simulator footage, ElevenLabs voice and captions, and
  ElevenLabs music about 12 dB under the voice.
- It shows:
  - sign-in and wallet;
  - buy;
  - post → launch receipts;
  - creator claim;
  - a stock tracker refusing an out-of-band buy;
  - graduation;
  - the mainnet proof on Arbiscan.

**Hackathon done**
- The HackQuest submission is in by Sat 3 Oct night.
- It includes: a public repo; the demo video; a pitch deck; verified contract
  addresses for both networks; the live web app URL; the Android APK and iOS
  Simulator build in a GitHub release; and a README.

## 4. Constraints and confirmed decisions

| # | Decision | Confirmed choice |
|---|---|---|
| D1 | Chain | **Arbitrum One + Arbitrum Sepolia.** Not Robinhood Chain; the plan does not compete for the reserved Robinhood slot. |
| D2 | Contracts | **Solidity launchpad + Stylus (Rust) curve maths.** |
| D3 | Trackers | **Chainlink stock trackers only**, with the band enforced in the contract. Pre-IPO and Tessera are dropped. |
| D4 | Quote assets | **ETH for posts/reels, USDC for stock trackers.** |
| D5 | Wallets | **Privy embedded EVM wallet on iOS, Android and web**; external wallets are offered on web through Privy. Users pay their own gas; the Sepolia faucet tops them up. Gas sponsorship is **P1**. |
| D6 | Repo | **New separate repo**, `juno-arbitrum`, at `/Volumes/Extreme SSD/Projects/juno-arbitrum`. New Railway service, Vercel project, database, Mongo database and app id. The STOCKLANA deploys are not touched. |
| D7 | AI agents | **None.** Core only; agents go in the pitch roadmap. |
| D8 | Networks | The **app and demo run on Arbitrum Sepolia**. There is also an **Arbitrum One mainnet proof**, which the user funds (~0.05 ETH) and runs; the agent prepares and verifies it. |
| D9 | Stale feed | **Buys revert and sells stay open** when the price is older than `maxAge` (default 3 days, covering weekends and holidays). |
| D10 | Test ETH | **The user funds** the deployer with about 0.5 Arbitrum Sepolia ETH from login-gated faucets. The agent generates the deployer and hands the user the address and a faucet list. |
| D11 | Deadline | Assume **Sun 4 Oct 23:59 SGT** and submit by Sat 3 Oct night. |

**Decisions made by default** (conventional; change only with reason):

- **Graduation:** a Uniswap v3 full-range position at 1% fee tier (0.3% for trackers). The position NFT is held by the curve contract forever, so liquidity is locked. The creator can call `collectLpFees()`, and the LP fees are split the same way as trading fees.
- **Token:** a plain ERC-20 with 18 decimals and a fixed supply of 1,000,000,000. The token's `metadataURI` points to IPFS JSON: name, symbol, description, image, animation_url (reel), and a link to the post.
- **Fees:**
  - The fee decays exponentially from `feeStartBps` to `feeEndBps` over `feeDecaySeconds`, measured from launch, using `block.timestamp`. Values come from the Solana presets.
  - The fee is taken in the quote asset. 50% goes to the creator, claimable; 50% goes to the protocol treasury.
- **Server-built transactions:** as on Solana, the server returns `{to, data, value, chainId}` and the device signs and sends through Privy. This keeps quoting, slippage and the ABI in one place.
- **Indexing:** our own event poller on the server, using viem `getLogs` over the factory's and curves' events, writing to Postgres. There is no hosted indexer, so there are no extra accounts to set up.
- **Addresses:** stored lowercased as `varchar(42)`, and checksummed only for display.
- **Bundle id:** `app.launch.junoarb`, URL scheme `junoarb`. The user adds both to the Privy dashboard, and enables Ethereum embedded wallets on the existing Privy app or on a new one.
- **Brand:** stays "Juno". The accent colours and fonts are unchanged.

## 5. Final product specification

**User types.** Visitors (read-only), signed-in users (with a Privy wallet),
creators (users who launched a curve), and the protocol owner (treasury, faucet,
deployer).

**Screens.** These are the existing Expo screens, ported:
- onboarding;
- the Feed tab, with stories and posts;
- Reels;
- Trade, with a **Stocks** segment; the Pre-IPO segment is removed;
- Post (+), with the launch log receipts;
- Profile, with the wallet card, faucet, name, portfolio and holdings;
- the coin page, with the chart, depth, activity, holders, comments, creator claim and the band card for trackers;
- the trader page;
- a post detail page.

The web app is the same Expo app exported to web; the Next.js web UI is not
ported (see section 8).

**Contract surface**
- `JunoFactory`:
  - `launch(LaunchParams)` → (token, curve);
  - `launchTracker(TrackerParams)` → (token, curve);
  - preset registry, quote-asset allowlist (WETH-as-native-ETH, USDC), treasury, and the Stylus `CurveMath` address;
  - events `Launched(curve, token, creator, preset, quote, feed, metadataURI)`.
- `JunoCurve`, one clone per launch:
  - `buy(minOut)` payable for ETH, and `buyExactIn(amountIn, minOut)` for USDC;
  - `buyExactOut(amountOut, maxIn)`;
  - `sell(amountIn, minOut)`;
  - `quoteBuy`, `quoteSell` and `quoteBuyExactOut` as views;
  - `claimCreatorFees()`, `graduate()` (permissionless once full), and `collectLpFees()`;
  - events `Trade(trader, isBuy, amountIn, amountOut, feeCreator, feeProtocol, priceAfter, supplySold)`, `Claimed`, `Graduated(pool, positionId)`.
- `CurveMath` (Stylus):
  - `price(presetId, sold)`;
  - `costToBuy(presetId, sold, amount)`, `proceedsToSell(presetId, sold, amount)` and `amountForCost(presetId, sold, cost)`;
  - `segments(presetId)`.
  - Everything is pure and deterministic, in fixed-point with 1e18 scaling.
- Band check, in `JunoCurve` for trackers:
  - on buy, read the `AggregatorV3` latest round;
  - require `updatedAt >= now - maxAge`, else revert `MarketClosed()`;
  - require the post-trade price to be within `bandBps` of the feed price, converted to the quote asset's decimals, else revert `OutsideBand(price, ref, bandBps)`;
  - sells skip the check.

**Server API** (Next.js, the same route names where possible):
- **Reads:** `coins`, `coins/[token]`, `feed`, `depth`, `leaderboard`, `portfolio/[wallet]`, `posts`, `posts/[id]`, `stocks` (the Chainlink reference; this replaces `tessera`), `tx/balance`.
- **Builds:** `tx/launch`, `tx/swap` (buy, sell, exact-out), `tx/claim`, `tx/graduate`. Each returns `{to, data, value, chainId}`.
- **Records:** `pools` records a launch after its receipt, and `index` polls logs.
- **Social:** `comments`, `likes`, `follow`, `saved`, `profiles` (with EIP-191 signature verification), `watchlist`, `plans`.
- **Media:** `upload`, `metadata`, `ipfs/[cid]`.
- **Faucet:** sends 0.02 Sepolia ETH and, where the faucet wallet holds it, 5 Sepolia USDC. Sepolia only; rate-limited per wallet and IP.

**Data.** See section 7 for the Postgres changes. The Mongo collections
`comments`, `likes` and `profiles` keep their shape, keyed by the lowercase
token address and a `chainId` in place of `cluster`.

**States and failures**, each with explicit UI copy:
- no wallet;
- wallet creating;
- insufficient ETH or USDC;
- quote failed;
- slippage exceeded;
- `MarketClosed`;
- `OutsideBand`;
- transaction pending, confirmed, or reverted with the decoded reason;
- RPC busy (retry);
- empty feed;
- a curve that has graduated, where Trade links out to Uniswap.

## 6. Features by priority

**P0, required**
1. Contracts: the factory, curve, token and Stylus `CurveMath`, with the 4 presets, decaying fee, creator claim and graduation to Uniswap v3.
2. The tracker band check against Chainlink, and the staleness rule (D9).
3. Deploy and verify on Arbitrum Sepolia; mock Chainlink feeds for TSLA, NVDA and AAPL on Sepolia.
4. Server: quotes, transaction builders, the event indexer, and hydration of coins, feed, portfolio and leaderboard from events.
5. Privy EVM wallet in the Expo app (native and web), EIP-191 name claims, and the Sepolia faucet.
6. App ported: feed, reels, buy/sell sheet, launch flow with receipts, creator claim, Stocks tab and band card, profile and portfolio. All Solana copy removed.
7. Social (likes, comments, follows, profiles) working on the new keys.
8. Demo data: 4–6 real posts and reels (Pexels) launched by `demo_` wallets, trades on them, 3 stock trackers, and one curve filled to graduation.
9. Arbitrum One: deploy, verify, one post curve, one TSLA tracker against the real feed, and a README proof table. The user funds and runs this.
10. Deliverables: web deploy, Android APK, iOS Simulator build, GitHub release, demo film, pitch deck, README and submission.

**P1, important**
- Gas sponsorship through Privy.
- The depth chart and exact-out buy (the depth route is ported in P0 only if it's cheap).
- Watchlist and plans.
- A leaderboard page.
- `collectLpFees()` in the UI.

**P2, enhancement.** Following feed, share cards, push notifications,
multi-chain switch.

**Post-MVP**
- Robinhood Chain deployment with real Robinhood stock tokens as the tracker quote.
- AI agents: auto-buyers with Privy session keys.
- Arbitrum One as the default app network.
- Audits.
- Uniswap v4 hooks for graduated pools.

## 7. Architecture and end-to-end flows

```
Expo app (iOS/Android/web) ── Privy embedded EVM wallet (sign + send)
        │  REST
        ▼
Next.js API on Railway ── viem public client ── Arbitrum Sepolia / One RPC
  │   builds calldata, quotes via CurveMath/JunoCurve views
  │   indexer: getLogs(Factory.Launched, Curve.Trade/Claimed/Graduated) → Postgres
  ├── Postgres (Neon, new database)   juno_curves, juno_trades, juno_posts, social graph
  ├── MongoDB (new db `juno_arb`)      comments, likes, profiles, faucet key
  └── Pinata IPFS                      images, reels, posters, token metadata JSON
Contracts: JunoFactory ─clones→ JunoCurve ─calls→ CurveMath (Stylus)
           JunoCurve ─reads→ Chainlink AggregatorV3 (trackers)
           JunoCurve ─graduates→ Uniswap v3 NonfungiblePositionManager
```

**Postgres changes.** These are new migrations in the new repo, not changes to the Solana database.

- `juno_curves`:
  - replaces `juno_pools`;
  - PK `token` (varchar 42);
  - columns `curve`, `creator`, `quote` (`eth`|`usdc`), `preset`, `feed` (nullable), `band_bps`, `chain_id`, `tx_hash`, `block_number`, `format` (post|reel), `listed`, `metadata_uri`, `created_at`.
- `juno_trades`:
  - PK (`tx_hash`, `log_index`);
  - columns `curve`, `trader`, `is_buy`, `amount_in`, `amount_out`, `fee_creator`, `fee_protocol`, `price_after`, `supply_sold`, `block_number`, `block_time`, `chain_id`.
- `juno_index_cursor`: (`chain_id`, `last_block`).
- `juno_posts`, `juno_follows`, `juno_watchlist` and `juno_plans` keep their shape with `chain_id` in place of `cluster`, and 42-character addresses.

### Flow A: sign-in → wallet → faucet → name
1. Profile → Continue with email → Privy OTP.
2. `useEmbeddedEthereumWallet` creates the wallet.
3. The app switches to chain 421614.
4. The faucet sends ETH (and USDC) → the balance is shown.
5. Name claim:
   1. Sign an EIP-191 `personal_sign` message: `Juno name: x\nWallet: 0x…\nIssued: <iso>`.
   2. The server runs `verifyMessage`.
   3. The server stores the name in Mongo.
- **Failure:** OTP wrong → inline error; wallet error → retry; faucet rate-limited → message with the time left.

### Flow B: buy a post
1. Tap Buy → amount → `GET quote` (server calls `quoteBuy`).
2. `POST tx/swap` returns `{to, data, value}` with `minOut`, which the quote reduces by slippage.
3. Privy sends the transaction → wait for the receipt.
4. The server records the trade from the receipt logs straight away; the indexer also catches it.
5. The receipt shows the tx hash, a link to Arbiscan and the time.
- **Failure:** insufficient balance (checked before signing), slippage revert (decoded), RPC busy (retry).

### Flow C: post → launch
1. Pick a photo or reel → upload to Pinata (poster frame for reels).
2. Metadata JSON is pinned to IPFS.
3. `POST tx/launch` with the preset and quote → `factory.launch` calldata.
4. Sign → receipt → the `Launched` event gives the token and curve addresses.
5. `POST pools` records the launch.
6. The launch log shows receipts with timestamps: IPFS, launch tx, curve address, listed.

### Flow D: stock tracker buy, in and out of band
1. The Stocks tab shows each tracker with the Chainlink price and its age, the curve price, the band and the market state.
2. A buy inside the band succeeds.
3. A buy large enough to push the price out of band shows a warning before signing (from the quote). If sent anyway, the contract reverts with `OutsideBand`, and the app decodes it and says so.
4. When the feed is stale, the app shows "Market closed · sells only", and buying is disabled with the reason.

### Flow E: creator claim
The coin page shows accrued creator fees (a curve view) → Claim → tx → receipt. Only the creator sees the button, and the contract enforces it.

### Flow F: graduation
1. When `supplySold` reaches the preset's graduation threshold, anyone can call `graduate()`. The server triggers it after the filling buy, and the demo does this explicitly.
2. The curve mints a v3 full-range position with the remaining tokens plus the collected quote (native ETH is wrapped to WETH for the v3 position).
3. The curve emits `Graduated` → the app shows "Trading on Uniswap" with a link.

## 8. Current codebase state (what the port starts from)

The Solana repo (branch `juno`, v1.1.0) is a working, deployed product. Its code
inventory, from a full scan:

**Rewrite: Solana-only**
- `lib/juno/dbc.ts` (1,048 lines, the Meteora adapter), `tx.ts`, `damm.ts`, `curve-shape.ts`, `economics.ts`, `cluster.ts`, `faucet.ts`.
- The Pyth account decoder in `pyth.ts`, and the Token-2022 read in `tessera.ts` (dropped).
- API routes `faucet`, `tx/*`, `pools`, `index`, `depth`.
- Expo `lib/wallet.tsx`, `lib/privy.native.tsx`, `lib/privy.types.ts`, `lib/privy.tsx`, `lib/polyfills.ts`.
- All `scripts/juno-*.ts`, `mainnet-*.sh`.

**Port with small changes (mixed)**
- `chain.ts` (hydration), `curves.ts` (the preset table is kept), `depth.ts`.
- `swaps.ts`: `volumeWithin`, `priceSeries` and `changeWithin` are kept; decoding becomes events.
- `activity.ts`, `portfolio.ts` (the cost basis and P&L maths are kept), `profiles.ts` (becomes EIP-191), `social-graph.ts` (the address regex).
- Expo `lib/api.ts`, `WalletCard`, `TradeSheet`, `QuickTrade`, `coin/[mint].tsx`, `(tabs)/post.tsx`, `profile.tsx`, `index.tsx`, `SignInSheet`, `trader/[wallet].tsx`.

**Keep as-is**
- `rpc.ts` (retry and TTL cache), `api.ts`, `registry`/`posts`/`swap-store` data access (re-keyed), `social.ts`, `crowd.ts`, `format.ts`, `identicon.ts`, `media.ts`, `pinata.ts` (metadata shape changes), `poster.ts`.
- Almost all Expo components (`kit`, `BottomSheet`, `FeedCard`, `Candles`, `AreaChart`, `DepthChart`, `CurvePreview`, `CommentsSheet`, …) and screens.
- The demo tooling in `scripts/demo/`: HyperFrames builder, ElevenLabs voice and music, clips, remix.

**Not ported:** the Next.js web frontend (`app/(juno)/`, `components/juno/`).
The Expo web export is the web app, as it already was in production. Porting
both UIs would double the wallet work for no judging gain.

**Tests:** Vitest, about 125 Juno unit tests. The chain-agnostic ones are kept:
candles, money, format, markets, portfolio, crowd, rpc-cache. The Solana-coupled
ones (curves, swaps, names, holders) are rewritten against events and EIP-191.
The integration tests are rewritten against Arbitrum Sepolia.

**No TODO, FIXME, mock or stub markers exist.** The hardcoded Solana constants
are listed in section 9.

## 9. Gap audit (target vs. the Solana repo)

| Gap | Evidence | Impact | Severity | Blocks | Resolution |
|---|---|---|---|---|---|
| No EVM contracts exist | repo has only Meteora calls | nothing can launch/trade | BLOCKER | all | Phase 2 |
| No Stylus toolchain | `cargo stylus` not installed (`no such command`) | CurveMath can't build | BLOCKER | Phase 2 | T1.3 |
| No funded Sepolia deployer | D10 | can't deploy | BLOCKER | Phase 3 | T1.4 (user) |
| Chainlink equity feed addresses unknown | not yet looked up | tracker mainnet proof | HIGH | Phase 7 | T1.6 |
| Arbitrum Sepolia has no equity feeds | research | trackers on Sepolia | HIGH | Phase 3 | deploy `MockAggregator` (T2.6) and a keeper script to keep it fresh |
| Swap history decoded from Solana vault deltas | `lib/juno/swaps.ts` | charts/portfolio/leaderboard empty | BLOCKER | Phase 4 | event indexer T4.3 |
| Name claims use ed25519/base58 | `lib/juno/profiles.ts`, `WalletCard.tsx:177` | names fail | HIGH | Phase 5 | EIP-191 T4.6/T5.4 |
| Base58 address regex in 6 places | `app/api/juno/{pools,comments,likes,profiles}`, `social-graph.ts:24`, `trader/[wallet].tsx:73` | every social write 400s | HIGH | Phase 4 | shared `isAddress` T4.7 |
| Faucet sends SOL | `app/api/juno/faucet/route.ts` | new users can't trade | HIGH | Phase 5 | ETH/USDC faucet T4.8 |
| Privy configured for Solana | `privy.native.tsx` `embedded.solana` | no EVM wallet | BLOCKER | Phase 5 | T5.1 |
| Web build has no Privy | `lib/privy.tsx` stub | web users can't sign | HIGH | Phase 5 | `@privy-io/react-auth` on web T5.2 |
| Hardcoded WSOL/USDC mints, Solscan, "Solana devnet" copy | `lib/api.ts:144-146,926`, `index.tsx:32`, `TradeSheet.tsx:181,192`, `post.tsx` | wrong UI | MEDIUM | Phase 5 | T5.6 |
| Pre-IPO tab + Tessera | `trade.tsx`, `tessera.ts` | dropped scope (D3) | MEDIUM | Phase 5 | remove T5.7 |
| Metaplex-shaped metadata | `pinata.ts` | wrong token metadata | LOW | Phase 4 | T4.9 |
| DB keyed by `cluster`, base58 | `lib/db/schema.ts:1042-1336` | — | HIGH | Phase 4 | new migrations T4.1 |
| Demo voice/copy mentions Solana/Meteora | `scripts/demo/vo.py`, `build_hf.py` | wrong film | MEDIUM | Phase 8 | T8.2 |
| No Arbitrum explorer verification | — | contract-quality score | HIGH | Phase 3/7 | `forge verify-contract` + `cargo stylus verify` |
| Submission form fields unknown | HackQuest page shows none | may miss a field | MEDIUM | Phase 9 | user checks form early (T1.7) |

## 10. Implementation phases and tasks

Status tags reflect the new repo, which is empty apart from this plan.
Everything is `[NOT STARTED]` unless marked otherwise.

### Phase 0 — Plan [DONE]
- T0.1 [DONE] Research the hackathon, the chains and the Solana codebase; settle decisions D1–D11.

### Phase 1 — Setup and unblockers (Mon 28 Sep)
*Objective:* a repo, toolchains, keys and addresses, so contract work can start.
*Exit:* `forge build` and `cargo stylus check` both pass on hello-world code; the deployer is funded on Sepolia; every external address is recorded in `config/addresses.ts` and marked verified.

- T1.1 [NOT STARTED] **Create the repo.**
  - `git init` at `/Volumes/Extreme SSD/Projects/juno-arbitrum`, with a monorepo layout: `contracts/` (Foundry), `stylus/` (Rust crate), `server/` (Next.js API only), `app/` (Expo), `scripts/`, `docs/`.
  - Copy in the keep and mixed files listed in section 8, with the Solana pieces removed.
  - Create the GitHub repo. Confirm the owner first: the Solana repo's latest commit points links at `robinbanter/juno`, so ask which account to use. Public.
  - *Accept:* `npm i` works in `server/` and `app/`; `grep -ri "solana\|meteora\|lamport\|bs58\|web3.js" --exclude-dir=node_modules` returns nothing outside `docs/history`.
- T1.2 [NOT STARTED] **Install Foundry deps** in `contracts/`: OpenZeppelin (ERC20, Clones, SafeERC20, ReentrancyGuard), Uniswap v3 periphery interfaces, and Chainlink `AggregatorV3Interface`.
- T1.3 [NOT STARTED] **Install the Stylus toolchain:**
  - `cargo install cargo-stylus`; `rustup target add wasm32-unknown-unknown`;
  - Docker, for reproducible verification;
  - scaffold `stylus/curve-math` with `stylus-sdk`.
  - *Accept:* `cargo stylus check` passes against the Arbitrum Sepolia RPC.
- T1.4 [BLOCKED on user] **Fund the deployer:**
  1. Generate the deployer and faucet keys with `cast wallet new`. Store them in `.env` (gitignored) and never print them.
  2. Give the user the addresses and a faucet list: Alchemy, QuickNode, Chainlink and the Arbitrum Discord Arbitrum Sepolia faucets, or bridging Sepolia ETH through the Arbitrum bridge.
  3. The user sends about 0.5 ETH.
  - *Accept:* `cast balance` ≥ 0.4 ETH.
- T1.5 [NOT STARTED] **Record external addresses** in `config/addresses.ts`, one entry per chain (421614, 42161), each checked on the explorer before use:
  - WETH: One `0x82aF49447D8a07e3bd95BD0d56f35241523fBab1`;
  - USDC: One `0xaf88d065e77c8cC2239327C5EDb3A432268e5831`, Sepolia Circle `0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d`;
  - Uniswap v3 `NonfungiblePositionManager` and factory on both chains;
  - Sepolia WETH.
  - *Accept:* a script calls `symbol()` and `decimals()` on each address and asserts the values.
- T1.6 [NOT STARTED] **Look up the Chainlink feeds** for TSLA/USD, NVDA/USD and AAPL/USD on Arbitrum One (data.chain.link → Arbitrum mainnet). Record the address, decimals and heartbeat. Read `latestRoundData` once to confirm.
- T1.7 [BLOCKED on user] The user opens the HackQuest submission form and pastes its fields and the exact deadline time into `docs/SUBMISSION.md`.
- T1.8 [BLOCKED on user] **Privy setup:**
  - enable Ethereum embedded wallets;
  - add bundle id `app.launch.junoarb` and scheme `junoarb` to the allowed lists;
  - add the web origins (Vercel URL, `localhost:8081`) to the allowed origins;
  - set the default chain to Arbitrum Sepolia.
  - The app id and client id are public; the app secret is never written anywhere.

### Phase 2 — Contracts (Tue 29 – Wed 30 Sep) — critical path
*Objective:* audited-quality contracts with thorough tests.
*Exit:* `forge test` is green with ≥ 90% line coverage on `JunoCurve` and `JunoFactory`; differential tests between the Stylus maths and the Solidity reference model pass on a Sepolia fork.

- T2.1 **`CurveMath` in Stylus.**
  - Write the 16-segment piecewise-linear price curve. Port the four presets' liquidity weights exactly from the Solana repo's `lib/juno/curves.ts`:
    - content: 1.2^i;
    - thin-name: 0.82^i;
    - ipo-book: 0.25 + 0.75·t², t ∈ [−1, 1];
    - tight-nav: uniform.
  - Segment price bounds run geometrically from `p0` to `p0·capMultiple`. The default multiple is 25; for tight-nav the default is 1.5 and the max is 3.
  - Functions as in section 5. Use U256 fixed point; round buys up and sells down.
  - *Accept:* `cargo test` covers monotonicity, cost(a)+cost(b)=cost(a+b) within 1 wei, and `amountForCost(costToBuy(x)) == x` within 1 wei.
- T2.2 **`CurveMathRef.sol`**: a Solidity mirror of the same maths, used only in tests for differential fuzzing. It is never deployed.
- T2.3 **`JunoToken.sol`**: ERC-20 with the fixed supply minted to the curve, plus `metadataURI`.
- T2.4 **`JunoCurve.sol`** (clone, initializer):
  - buy / buyExactOut / sell and the quote views;
  - fee decay (`fee = end + (start−end)·exp(−t/τ)`, approximated with a precomputed lookup or a Taylor expansion in fixed point, checked against a Python reference);
  - creator fee accrual and claim; reentrancy guard;
  - slippage parameters; `deadline`;
  - native ETH or USDC quote.
- T2.5 **Band and staleness check** in `JunoCurve`, for trackers only (section 5 semantics).
  - Scale the feed decimals to the USDC decimals (6).
  - Custom errors `MarketClosed`, `OutsideBand`.
  - Sells are exempt.
- T2.6 **`MockAggregator.sol`**: owner-settable price and `updatedAt`, used on Sepolia.
- T2.7 **Graduation:**
  1. `graduate()` checks the threshold.
  2. It computes `sqrtPriceX96` from the final curve price.
  3. It creates and initializes the v3 pool and mints a full-range position with the remaining tokens and the collected quote (native ETH wrapped to WETH).
  4. It keeps the NFT and emits `Graduated`.
  5. `collectLpFees()` splits the fees creator/protocol.
  - Any dust from the price and tick rounding goes to the treasury.
- T2.8 **`JunoFactory.sol`**: presets (id → weights index, fee schedule, sell-out %, graduation fee tier, cap multiples), the quote allowlist, treasury, `CurveMath` address, `launch` / `launchTracker`, and events. Clones via OpenZeppelin `Clones`.
- T2.9 **Foundry tests:**
  - Unit tests for each function and revert path.
  - Fuzz tests on buy/sell round trips (no value extraction: buying then selling can't return more than was paid).
  - Invariants: quote balance ≥ Σ owed; creator fees ≤ fees taken; supplySold ≤ curve supply.
  - A fork test against Arbitrum One for graduation into the real v3 position manager.
  - Band tests with a mock feed: fresh/stale, in/out of band, sell exempt.
  - Differential tests: Stylus (deployed on the fork or through `vm.etch` of the activated program) vs `CurveMathRef`.
- T2.10 **Gas report and NatSpec** on all external functions; `slither` run with results triaged into `docs/SECURITY.md`.
- *Risk:* the Stylus call from a Foundry test. *Mitigation:* test Stylus through a Sepolia fork after deployment (T3.1), and keep `CurveMathRef` as the in-process oracle. If Stylus activation is blocked for more than 4 hours, deploy with `CurveMathRef` behind the same interface, ship, and state it in the README. This is a last resort, because D2 requires Stylus.

### Phase 3 — Deploy to Arbitrum Sepolia (Wed 30 Sep)
- T3.1 **Deploy `CurveMath`** with `cargo stylus deploy`; the deploy also activates it. Run `cargo stylus verify`.
- T3.2 `forge script Deploy.s.sol` for the factory, curve implementation, and three `MockAggregator`s (TSLA, NVDA, AAPL, seeded from the real One feeds' latest prices). Verify on Arbiscan (Sepolia).
- T3.3 **`scripts/keep-feeds-fresh.ts`**: every 30 minutes, copies the real Arbitrum One Chainlink price (read through the One RPC) into the Sepolia mocks.
  - It stops updating on weekends so the market-closed state is real.
  - A `--force-open` flag allows demo recording.
- T3.4 **Smoke script:** launch 1 post (ETH) and 1 tracker (USDC); buy, sell, claim, and an out-of-band buy that must revert. Write the tx hashes to `docs/sepolia-proof.log`.
- *Exit:* every contract verified; the smoke script passes; addresses in `config/addresses.ts` and the README.

### Phase 4 — Server (Wed 30 Sep – Thu 1 Oct)
*Objective:* every read and build route works against Sepolia.
*Exit:* the ported integration tests pass against Sepolia; the feed returns the smoke-test curves with real prices and trades.

- T4.1 **Migrations** for `juno_curves`, `juno_trades`, `juno_index_cursor`, plus the re-keyed social-graph tables (section 7), on a new Neon database. Also create Mongo database `juno_arb` with unique indexes on `(token, chainId, wallet)` for likes and `(chainId, wallet)` / `(chainId, nameKey)` for profiles.
- T4.2 **`lib/chain.ts`**: viem public clients per chain with fallback RPC and retry (reuse `rpc.ts`), `explorerTx`/`explorerAddress` pointing at Arbiscan, `uniswapUrl`.
- T4.3 **Indexer** (`lib/indexer.ts` + `POST api/index`, also called by a cron every 30 seconds):
  - `getLogs` from the cursor in batches of 5,000 blocks, for `Launched`, `Trade`, `Claimed` and `Graduated`;
  - idempotent upserts on (tx_hash, log_index);
  - reorg safety: re-scan the last 20 blocks.
- T4.4 **Hydration:** port `hydratePool` → `hydrateCurve`, which reads `supplySold`, the price, the quote balance and the graduated flag in one multicall per batch of curves. Port volume, price series, change and holders from the `juno_trades` rows (reusing the maths in `swaps.ts`, `activity.ts`, `portfolio.ts`).
- T4.5 **Builders:**
  - `tx/launch`, `tx/swap` (buy/sell/exact-out with slippage bps), `tx/claim`, `tx/graduate`;
  - quotes come from curve views; ETH and USDC paths;
  - USDC buys return two steps (`approve` then `buy`) when the allowance is short.
  - `stocks` route: Chainlink price and age plus market state.
- T4.6 **Profiles:** EIP-191 `verifyMessage`, message format as in Flow A, and a replay window of 10 minutes on `Issued`.
- T4.7 **Shared address validation:** `isAddress` from viem, lowercased, in every route. This replaces the six base58 regexes.
- T4.8 **Faucet (Sepolia only):**
  - The faucet key is encrypted in Mongo, reusing `lib/custodial-keys.ts`.
  - It sends 0.02 ETH and 5 USDC if held.
  - Limit: one per wallet per 24 hours and 3 per IP per 24 hours. Returns 503 when the faucet is empty.
- T4.9 **Metadata JSON** in ERC-721-style fields (name, symbol, description, image, animation_url, external_url), pinned before launch.
- T4.10 **Deploy the API** to a new Railway service with a new domain. Set its env vars:
  - `DATABASE_URL`, `MONGODB_URI`, `MONGODB_DB=juno_arb`, `PINATA_JWT`, `CUSTODIAL_KEY_ENCRYPTION_SECRET`;
  - `ARB_SEPOLIA_RPC`, `ARB_ONE_RPC`, `APP_CHAIN_ID=421614`.
  - Keyed RPCs are set by the user; the agent never enters API keys into dashboards.

### Phase 5 — App (Thu 1 – Fri 2 Oct)
*Objective:* every flow in section 7 works on the iOS Simulator and the web.
*Exit:* all six flows (A–F) run end-to-end on the iOS Simulator; web sign-in and buy work.

- T5.1 **Privy native:** `useEmbeddedEthereumWallet`, `createOnLogin: 'users-without-wallets'`, switching to chain 421614. `sign` becomes `eth_sendTransaction` with the server's `{to, data, value}`; `signMessage` becomes `personal_sign`. Keep the sign-in sheet and the diagnostic status from the Solana repo. Remove the `@solana/web3.js`, `bs58`, `tweetnacl` and `buffer` polyfills.
- T5.2 **Privy on web:** `@privy-io/react-auth` in `lib/privy.web.tsx`, exposing the same bridge interface, with email plus external wallets.
- T5.3 **Wallet card:** ETH and USDC balances, the faucet button, and an "Arbitrum Sepolia" label.
- T5.4 **Name claim** through `personal_sign`.
- T5.5 **Trade sheet:**
  - ETH/USDC amounts, and a gas reserve of 0.0005 ETH (replacing the SOL `FEE_RESERVE`);
  - the approve+buy two-step for USDC;
  - decoded revert reasons, including `OutsideBand` and `MarketClosed`;
  - the receipt with an Arbiscan link and the time.
- T5.6 **Remove all Solana copy and constants:** the WSOL mint, Solscan, "Solana devnet", the Meteora launch-log copy, and the 1232-byte note. The launch log steps become: IPFS → launch tx → curve address → listed.
- T5.7 **Trade tab:** remove Pre-IPO. The Stocks segment shows Chainlink price and age, curve price, band and market state (open / closed · sells only), using the existing `StockLogo`.
- T5.8 **Coin page:** band card for trackers; creator claim; graduated state with a Uniswap link; depth chart (P1).
- T5.9 New bundle id and scheme; app icon unchanged; app name "Juno".

### Phase 6 — Demo data (Fri 2 Oct)
- T6.1 Port `scripts/juno-demo-activity.ts` to EVM. It generates `demo_` wallets, funds them from the faucet, and launches 4–6 posts and reels from the Pexels clips already in the Solana repo's assets. It launches 3 trackers (TSLA, NVDA, AAPL) and trades 20–40 times across them.
- T6.2 Fill one small content curve to graduation, so a real `Graduated` event and v3 pool exist.
- T6.3 Seed comments and likes from the demo wallets through the API. Seed nothing directly into the database.
- *Exit:* the feed shows ≥ 6 markets with non-zero volume, charts and holders.

### Phase 7 — Arbitrum One proof (Fri 2 Oct, a weekday, so the Chainlink feed is fresh)
- T7.1 The agent prepares `scripts/mainnet-proof.sh`. It prints each transaction's to/data/value and waits for the user to type `yes`. It does:
  1. deploy `CurveMath` (Stylus) and verify it;
  2. deploy the factory and verify it;
  3. launch 1 post with ETH and 1 TSLA tracker against the real Chainlink TSLA/USD feed;
  4. buy 0.001 ETH on the post;
  5. make an in-band tracker buy, and prove that an out-of-band buy reverts using `eth_call` (no gas spent).
- T7.2 **The user funds and runs it.** The agent never sends mainnet transactions. The agent records the hashes in `docs/mainnet-proof.log` and in the README's "Live on Arbitrum One" table.
- *Budget:* ≤ 0.05 ETH.

### Phase 8 — Deliverables (Fri 2 – Sat 3 Oct)
- T8.1 **Builds:**
  - web: Expo export → Vercel, new project;
  - Android APK: arm64 release, Java 17 from Homebrew, `-PreactNativeArchitectures=arm64-v8a`;
  - iOS Simulator build: `xcodebuild -sdk iphonesimulator CODE_SIGN_IDENTITY=- CODE_SIGNING_REQUIRED=NO`, with `pod install` under `LANG=en_US.UTF-8`;
  - a GitHub release containing all of them.
- T8.2 **Demo film:** reuse `scripts/demo/` from the Solana repo (`build_hf.py`, `clips.py`, `vo_eleven.py`, `music_eleven.py`, `remix.py`).
  - New narration lines covering the Arbitrum, Stylus, Chainlink band, Uniswap graduation and Privy story.
  - Record the chapters on the iOS Simulator; sign-in is done by the user with a Privy test account.
  - Keep the layout the user approved: the phone alternating sides over a lime disc, typed titles, no numbers, and word-lit captions.
  - At most 5 minutes; music about 12 dB under the voice.
- T8.3 **Pitch deck** (8–10 slides): problem, product, how it works (contracts diagram), Stylus + Chainlink band as the new primitive, traction/proof (Sepolia and One addresses), market, roadmap (Robinhood Chain stock tokens as the quote, agents, gasless), team, ask.
- T8.4 **README:** what it is; try it (web, APK, Simulator); architecture; contracts with verified addresses; the mainnet proof table; how to run; security notes.
- T8.5 Submit on HackQuest (the user clicks submit); confirm every field against T1.7.

### Phase 9 — Buffer (Sun 4 Oct)
Fix whatever the dry run found; re-record at most one chapter; no new features.

## 11. Testing strategy

- **Contracts** (`forge test -vvv`, `forge coverage`):
  - unit, fuzz (10k runs) and invariant suites;
  - an Arbitrum One fork test for graduation;
  - differential Stylus-vs-Solidity maths tests;
  - `slither`.
- **Stylus:** `cargo test`, plus property tests (proptest) on monotonicity and round trips.
- **Server:**
  - Vitest units kept from the Solana repo (candles, money, format, markets, portfolio, crowd, rpc-cache);
  - new tests for event decoding, hydration from `juno_trades`, EIP-191 name verification, the faucet rate limit, and builders (the calldata decodes to the expected function and args);
  - integration tests against Arbitrum Sepolia: launch, buy, sell, claim, band revert.
- **App:** manual runs of flows A–F on the iOS Simulator and web, with screenshots in `docs/qa/`, plus a smoke run of the Android APK on the `juno35` emulator.
- **Fresh-state checks:** empty database (the feed shows an empty state, not an error), a new account (faucet, first buy), a dead RPC (retry, then a clear error), a stale feed (buys disabled).

## 12. Deployment and operations

| Piece | Where | Notes |
|---|---|---|
| Contracts | Arbitrum Sepolia 421614, Arbitrum One 42161 | verified on Arbiscan, Stylus verified via `cargo stylus verify` |
| API | Railway, new service `juno-arb-api` | `railway up --detach`; cron hits `/api/index` every 30 seconds |
| DB | Neon, new database | drizzle migrations in `server/drizzle` |
| Mongo | existing cluster, new database `juno_arb` | |
| Media | Pinata (existing JWT) | |
| Web | Vercel, new project `juno-arb` | Expo web export |
| Feed keeper | Railway cron or a local `launchd` job | Sepolia mocks only |

**Secrets:**
- Deployer and faucet keys stay only in the local `.env` and Railway variables.
- The Privy app secret and ElevenLabs key are never written to files.
- The user rotates the keys pasted in chat after the event.

**Monitoring:**
- `/api/health` reports the database, Mongo, the RPC, the indexer lag in blocks, and the faucet balance.
- The Railway logs.

## 13. Demo and hackathon strategy

**The demo must be real where it proves the core claim:**
- **Must work live:** Privy sign-in, faucet, buy, launch, creator claim, the tracker's in-contract band revert, graduation, and the Arbiscan links.
- **Safe to simulate:** the Sepolia price feeds are mocks that copy the real Arbitrum One price. Say so on screen. "Market open" during weekend recording uses `--force-open`, and the film says it's a Sepolia mock.
- **Must not be faked:** the band revert must come from the contract, not the UI. Trades, likes, comments and holders must be real. The mainnet proof uses the real TSLA feed.

**Demo film chapters**
1. Cold open.
2. Problem.
3. Sign in (Privy).
4. Feed and buy.
5. Reels.
6. Post → launch receipts.
7. Creator claim.
8. Stock tracker: in-band buy works, out-of-band buy is refused by the contract, and the "market closed" state.
9. Graduation to Uniswap v3.
10. Under the hood: Stylus curve maths, contracts diagram.
11. Arbitrum One proof on Arbiscan.
12. Close.

**Fallback:** a pre-recorded film is the submission. The live web app is a
bonus, and if the RPC is flaky it still reads from the indexed database.

**Judging criteria mapping**
- **Contract quality:** Stylus + Solidity, tests, fuzzing, invariants, verified contracts, slither.
- **PMF and real problem:** creator monetisation, and stock exposure held honest by an oracle.
- **Innovation:** the curve shape as a product decision, and the oracle band enforced inside a bonding curve.

## 14. Critical path and parallel work

**Critical path:** T1.3 Stylus toolchain → T2.1 CurveMath → T2.4/T2.5 JunoCurve →
T2.7 graduation → T3.1–T3.2 Sepolia deploy → T4.3–T4.5 indexer and builders →
T5.1/T5.5 app wallet and trade → T6 demo data → T8.2 film recording → submit.

**Can run in parallel:**
- User tasks T1.4, T1.7 and T1.8, all on day 1.
- Phase 4 social ports (T4.1, T4.6–T4.9) while the contracts are in progress.
- Phase 5 copy removal and Stocks UI (T5.6, T5.7) against mocked API responses in development only.
- Pitch deck (T8.3) and README (T8.4) from Thursday.
- Mainnet proof script (T7.1) as soon as Phase 3 passes.

**Final mile:** demo data, recording, film, deck, release, submission form.

## 15. Risks and mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| Stylus tooling or activation problems | Medium | Start day 1; keep `CurveMathRef.sol` behind the same interface as the last-resort fallback (see T2.10 risk note) |
| Fixed-point exp for fee decay is wrong | Medium | Precomputed 64-step lookup table with interpolation; Python reference tests |
| Graduation tick/price maths off | Medium | Arbitrum One fork test against the real v3 position manager; full-range position; dust to treasury |
| Sepolia faucets are slow for the user | Medium | Ask on day 1; 0.5 ETH covers deploys + faucet for ~15 users + demo |
| No equity feeds on Sepolia | Certain | Mock aggregators kept in sync with the real One feed; the film says so |
| Weekend = stale feed during recording | Certain | Record tracker chapters with `--force-open` on Sepolia; mainnet proof on Friday |
| Public Arbitrum RPC rate limits | Medium | User supplies a keyed RPC (Alchemy); `rpc.ts` retry; multicall batching |
| Privy EVM on Expo web differs from native | Medium | Separate `privy.web.tsx` with `react-auth`; same bridge interface |
| Scope overrun in 6 days | High | P0 list is the contract; P1 only after a full P0 dry run on Friday |
| Submission form surprise | Low | T1.7 on day 1 |

## 16. Exact execution order

1. **Mon 28:**
   - T1.1 repo, T1.2 Foundry deps, T1.3 Stylus toolchain;
   - T1.4 key generation, with the addresses sent to the user; T1.5 and T1.6 addresses;
   - user tasks T1.4, T1.7 and T1.8;
   - start T2.1.
2. **Tue 29:** T2.1–T2.6 (maths, token, curve, band, mock); T2.9 tests in step with the code.
3. **Wed 30:** T2.7–T2.10 (graduation, factory, full tests, slither) → T3.1–T3.4 Sepolia deploy and smoke → start T4.1–T4.3.
4. **Thu 1:** T4.4–T4.10 (server complete, deployed) → T5.1–T5.4 (wallet, faucet, names).
5. **Fri 2:**
   - T5.5–T5.9 (trade, launch, stocks, coin page);
   - T6 demo data;
   - T7 mainnet proof (the user runs it during US market hours);
   - full P0 dry run on the Simulator and web.
6. **Sat 3:** T8.1 builds and release; T8.2 record and render the film; T8.3 deck; T8.4 README; T8.5 **submit by night**.
7. **Sun 4:** buffer only.

## 17. Remaining unknowns

- The exact HackQuest submission fields and deadline timezone. The user checks (T1.7).
- The Chainlink TSLA/NVDA/AAPL feed addresses and heartbeats on Arbitrum One (T1.6).
- The Uniswap v3 deployment addresses on Arbitrum Sepolia (T1.5); if they are missing, graduation on Sepolia targets a v3 deployment we deploy ourselves, and the README says so.
- The GitHub owner for the new repo: the Solana repo was just re-pointed to `robinbanter/juno`. Confirm before T1.1.
- Whether Privy's EVM embedded wallet on Expo web works with the same app id as native (T5.2). Verify on day 4.
