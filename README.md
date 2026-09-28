# Juno — every post is a market, on Arbitrum

**Post a photo or a reel and it launches its own bonding curve on Arbitrum.**
People buy into the post as they scroll, the creator earns half of every
trading fee, and when the curve fills it graduates into a **Uniswap v3** pool
whose liquidity is locked forever.

The same curves issue **stock trackers**: a curve priced in USDC and held to a
**Chainlink** TSLA / NVDA / AAPL feed *by the contract itself*. A buy that
would lift the curve more than 1% above the stock reverts, and when the market
is closed (stale feed) buys stop while sells stay open.

The pricing maths — sixteen segments, an exact inverse search — runs in a
**Stylus** (Rust → WASM) program that the Solidity curves call.

Built for **Arbitrum Open House Singapore** (online buildathon, Sep 14 – Oct 4, 2026).

| | |
|---|---|
| **Try it** | **https://juno-arb-app.vercel.app** · Android APK + iOS Simulator build in [release v0.1.0](https://github.com/nickthelegend/juno-arbitrum/releases/tag/v0.1.0) |
| **Network** | Arbitrum Sepolia (test ETH — Profile → *Get test ETH*). Contracts also on Arbitrum One ([mainnet proof](#arbitrum-one-proof)). |
| **API** | https://juno-arb-api.vercel.app/api/health |
| **Docs** | [PLAN.md](PLAN.md) · [docs/API.md](docs/API.md) · [docs/SECURITY.md](docs/SECURITY.md) · [screenshots](docs/qa) |

## What's Arbitrum-native here

| Piece | What it does | Where |
|---|---|---|
| **Stylus `CurveMath`** | Prices every buy and sell: 16 geometric price segments sized by the preset's liquidity weights, costs rounded up / proceeds down, and the exact inverse (how many tokens does this much ETH buy?) by binary search over 512-bit maths — ~90 iterations per trade, cheap in WASM | [`stylus/curve-math`](stylus/curve-math/src) |
| **Solidity launchpad** | `JunoFactory` creates a post's token, an EIP-1167 curve clone and its Uniswap v3 pool (priced at launch); `JunoCurve` trades, decays its fee, splits fees with the creator, enforces the stock band, graduates | [`contracts/src`](contracts/src) |
| **Chainlink on Arbitrum** | TSLA/USD, NVDA/USD, AAPL/USD feeds hold trackers to a band; the Arbitrum **sequencer uptime feed** pauses tracker buys while the sequencer is down | `JunoCurve._checkBand` |
| **Uniswap v3 on Arbitrum** | A filled curve mints a full-range position into the pool created at launch; the NFT stays in the curve (locked), its fees split creator/protocol | `JunoCurve.graduate` |
| **Privy embedded wallets** | Email sign-in creates an EVM wallet on iOS, Android and web; no seed phrase, no extension | [`app/lib/privy.*`](app/lib) |

`CurveMathRef.sol` is the Solidity specification of the Stylus program; the
Foundry tests run against it, and [`scripts/diff-curve-math.ts`](scripts/diff-curve-math.ts)
checks the deployed Stylus program returns identical integers over random inputs.

## The four curve shapes

| Preset | Shape | Fee (start → end) | Sold on curve | Graduation pool |
|---|---|---|---|---|
| `content` | cheap early, steep late (weights 1.2^i) | 9% → 1% over 10 min | 20% | 1% tier |
| `thin-name` | deep at the issue price (0.82^i) | 5% → 0.6% over 15 min | 35% | 0.3% |
| `ipo-book` | deep at both ends (0.25 + 0.75t²) | 4% → 0.5% over 15 min | 30% | 0.3% |
| `tight-nav` | near flat, trackers only | 2% → 0.25% over 5 min | 50% | 0.3% |

Presets are fixed in the factory's constructor; nobody can change them.

## Architecture

```
Expo app (iOS / Android / web) ── Privy embedded EVM wallet signs + sends
        │ REST (docs/API.md)
        ▼
Next.js API (server/, Vercel) ── viem ── Arbitrum Sepolia / One
  builds calldata, quotes via curve views, indexes Launched/Trade/Claimed/Graduated
  ├── Postgres  juno_curves, juno_trades, posts, follows, watchlist
  ├── MongoDB   comments, likes, profiles (EIP-191 name claims), faucet claims
  └── Pinata    images, reels, token metadata
JunoFactory ─clones→ JunoCurve ─calls→ CurveMath (Stylus)
                     JunoCurve ─reads→ Chainlink feeds (+ sequencer uptime)
                     JunoCurve ─graduates→ Uniswap v3 position
```

## Deployments

Addresses live in [`config/addresses.ts`](config/addresses.ts) (the app and
server read them from there).

| | Arbitrum Sepolia (421614) | Arbitrum One (42161) |
|---|---|---|
| CurveMath (Stylus) | [`0x5125…4f37`](https://sepolia.arbiscan.io/address/0x5125c9e14b64acd48bf7116a93c9b66df89a4f37) | *pending* |
| JunoFactory | [`0xBc89…E87a`](https://sepolia.arbiscan.io/address/0xBc89E74A36a9EFf7B938211ea4B82650DA3BE87a) | *pending* |
| Curve implementation | [`0x3a4A…A9F1`](https://sepolia.arbiscan.io/address/0x3a4A8c33D8a3BacA2B58d608107a6E1Aa2B9A9F1) | *pending* |
| Quote for trackers | Juno Test USDC [`0x0afe…72ab`](https://sepolia.arbiscan.io/address/0x0afe4b5763813083D487B30215BDD21012c172ab) | Circle USDC `0xaf88…5831` |
| Stock feeds | MockAggregators mirroring Arbitrum One | Chainlink `TSLA/USD 0x3609…C3E3`, `NVDA/USD 0x4881…262F`, `AAPL/USD 0x8d0C…557c` |
| Uniswap v3 NonfungiblePositionManager | `0x6b29…4d65` | `0xC364…FE88` |
| Graduated example | `GRAD` → Uniswap v3 pool [`0x93fC…02CA`](https://sepolia.arbiscan.io/address/0x93fCeb86fd1Bc5aa85FE181b1560D7bfC1Bc02CA), position #3803 | — |

**Source verification.** The Solidity contracts (factory, curve
implementation, every launched token, test USDC, mock feeds) are verified on
[Sourcify](https://sourcify.dev) with exact matches; the factory and curve
implementation are also verified on
[Blockscout](https://arbitrum-sepolia.blockscout.com/address/0xBc89E74A36a9EFf7B938211ea4B82650DA3BE87a);
re-run with `bash scripts/verify.sh` (adds Arbiscan when `ARBISCAN_API_KEY` is
set). The Stylus program is proven by rebuilding it: `bash scripts/stylus-match.sh`
compiles `stylus/curve-math` with the pinned toolchain and compares the initcode
byte for byte with the deployment transaction (also run in CI,
[`stylus-verify`](.github/workflows/stylus-verify.yml)).

**Operations.** An indexer pass runs every 5 minutes
([`index`](.github/workflows/index.yml), authenticated with `JUNO_INDEX_SECRET`),
and the Sepolia mock feeds follow the real Arbitrum One feeds every 30 minutes
in US market hours ([`feeds`](.github/workflows/feeds.yml)), signed by a keeper
key that owns only the three mocks.

### Arbitrum One proof
Run by the deployer with `npx tsx scripts/mainnet-proof.ts` (it asks before
every transaction); results land in [`docs/mainnet-proof.log`](docs/mainnet-proof.log).

## Verification

| Suite | Result |
|---|---|
| Foundry (`contracts/`, Arbitrum One fork) | 31 tests incl. fuzz; 4 invariants × 8,192 random trades; line coverage JunoCurve 97%, JunoFactory 99%, JunoToken 100% |
| Rust (`stylus/curve-math`, `cargo test --lib`) | 9 property tests: monotone prices, additive costs, round trips never profit, exact inverse |
| `cargo stylus check` | passes on Arbitrum Sepolia (20.5 KB WASM) |
| Slither | no high-severity findings; triage in [docs/SECURITY.md](docs/SECURITY.md) |
| Server (`server/`, Vitest) | 132 unit tests; 13 integration tests run end-to-end against an Arbitrum Sepolia fork |
| App (`app/`) | `tsc` clean; web, iOS and Android bundles build |
| **Live on Arbitrum Sepolia** ([docs/sepolia-proof.log](docs/sepolia-proof.log)) | launch → buy → sell → creator claim → TSLA tracker $500 in-band buy → $9,500 buy refused `OutsideBand(361.67, 357.54, 1%)` → a post filled and graduated into Uniswap v3 (pool `0x93fC…02CA`, position #3803) |
| Stylus ≡ Solidity (`scripts/diff-curve-math.ts`) | the deployed Stylus program matched CurveMathRef on 720 calls over 120 random curves |
| Stylus reproducibility (`scripts/stylus-match.sh`) | rebuilt initcode is byte-identical to the deployment transaction (20,519 bytes) |
| End-to-end on a Sepolia fork | launch → buy → sell (no approve) → creator claim → USDC tracker in-band buy → out-of-band buy refused `OutsideBand(365.30, 361.22, 1%)` → fill → graduate into Uniswap v3 |

## Run it

```bash
# contracts
cd contracts && forge test                 # needs ARB_ONE_RPC for the fork
# stylus
cd stylus/curve-math && cargo test --lib && cargo stylus check --endpoint $ARB_SEPOLIA_RPC
# deploy (Stylus + Foundry + address book), then verify
bash scripts/deploy.sh                     # Arbitrum Sepolia
bash scripts/verify.sh && bash scripts/stylus-match.sh <deployment-tx>
# server
cd server && npm i && npm run db:migrate && npm run dev
bash scripts/deploy-api.sh                 # deploy the API to Vercel (env files never shipped)
# app
cd app && npm i && npx expo start
```

See [`server/README.md`](server/README.md) for the API's environment and scripts.

## Security

Not audited. Trust model, protections and known limitations are in
[docs/SECURITY.md](docs/SECURITY.md). Sepolia stock feeds are mocks mirroring
the real Arbitrum One feeds, and the app says so.

## Licence

MIT
