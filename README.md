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
| **Try it** | Web app: see [Deployments](#deployments) · Android APK + iOS Simulator build in [Releases](https://github.com/nickthelegend/juno-arbitrum/releases) |
| **Network** | Arbitrum Sepolia (test ETH — Profile → *Get test ETH*). Contracts also on Arbitrum One ([mainnet proof](#arbitrum-one-proof)). |
| **API** | https://juno-arb-api.vercel.app/api/health |
| **Docs** | [PLAN.md](PLAN.md) · [docs/API.md](docs/API.md) · [docs/SECURITY.md](docs/SECURITY.md) |

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
| CurveMath (Stylus) | *pending deploy* | *pending deploy* |
| JunoFactory | *pending deploy* | *pending deploy* |
| Quote for trackers | Juno Test USDC (faucet-mintable) | Circle USDC `0xaf88…5831` |
| Stock feeds | MockAggregators mirroring Arbitrum One | Chainlink `TSLA/USD 0x3609…C3E3`, `NVDA/USD 0x4881…262F`, `AAPL/USD 0x8d0C…557c` |
| Uniswap v3 NonfungiblePositionManager | `0x6b29…4d65` | `0xC364…FE88` |

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
| End-to-end on a Sepolia fork | launch → buy → sell (no approve) → creator claim → USDC tracker in-band buy → out-of-band buy refused `OutsideBand(365.30, 361.22, 1%)` → fill → graduate into Uniswap v3 |

## Run it

```bash
# contracts
cd contracts && forge test                 # needs ARB_ONE_RPC for the fork
# stylus
cd stylus/curve-math && cargo test --lib && cargo stylus check --endpoint $ARB_SEPOLIA_RPC
# deploy (Stylus + Foundry + address book)
bash scripts/deploy.sh                     # Arbitrum Sepolia
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
