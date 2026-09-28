# Juno server (Arbitrum)

The Next.js API behind the Juno app: an event indexer, hydration of coins from
contract state and recorded trades, transaction builders the app sends through
Privy, social features, media pinning and the Sepolia faucet. API-only — no
pages. The HTTP contract is `../docs/API.md`.

- **Chains:** Arbitrum Sepolia `421614` (the app's network) and Arbitrum One
  `42161` (read-only here; the mainnet proof is run by `../scripts`).
- **Contracts:** addresses and ABIs come from `../config/addresses.ts` and
  `../config/abi.ts` (imported as `@config/*`). While a chain's `factory` is
  null, every route that needs the contracts answers **503**
  `{ error: "Juno is not deployed on this chain yet (…)", deployed: false }`.
- **Stack:** Next 16 route handlers, viem (one Multicall3-batched client per
  chain), Postgres via drizzle (`juno_arb`), Mongo (`juno_arb`), Pinata.

## Run it

```sh
npm install
cp .env.example .env.local        # then fill it in
npm run db:create                 # creates the juno_arb database if missing
npm run db:migrate                # applies drizzle/ and lists the tables
npm run mongo:indexes             # unique indexes for likes/profiles, faucet TTL
npm run dev                       # http://localhost:3100
```

`npm run build && npm start` for production (`PORT` is honoured).

### Scripts

| Command | What it does |
|---|---|
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` / `npm run test:unit` | Vitest (unit tests need no network) |
| `npm run test:integration` | Arbitrum One Chainlink reads; the Sepolia end-to-end suite (skipped while the factory is null) |
| `npm run db:generate` | New drizzle migration from `lib/db/schema.ts` |
| `npm run index -- [chainId] [--loop]` | Run the indexer from the shell |
| `npm run demo -- [--api URL] [--funder faucet\|deployer]` | Phase 6 demo data through the API: `demo_` wallets, names, 6 posts/reels, 3 trackers, ~30 trades, a graduation, likes/comments/follows. Idempotent (`../.juno/demo-arb/`) |

### Local fork

`source scripts/fork-env.sh [rpc] [startBlock]` points this shell at an anvil
fork of Arbitrum Sepolia (default `http://127.0.0.1:8545`), merges
`../config/addresses.local.json` (`JUNO_LOCAL_ADDRESSES=1`) and switches to
separate `juno_arb_fork` Postgres/Mongo databases so fork data never mixes with
the real chain. A local RPC is used alone (no public fallback). Then
`npm run dev`, `npm run index`, `npx vitest run tests/integration` and
`npx tsx --conditions=react-server scripts/demo-activity.ts --api http://localhost:3100`
all run against the fork; wallets are funded with `anvil_setBalance`.

## Environment

Required in production:

| Name | Purpose |
|---|---|
| `DATABASE_URL` | Postgres `juno_arb` |
| `MONGODB_URI`, `MONGODB_DB` (`juno_arb`) | comments, likes, profiles, faucet claims |
| `APP_CHAIN_ID` | `421614` |
| `ARB_SEPOLIA_RPC`, `ARB_ONE_RPC` | keyed RPCs (public endpoints are the fallback) |
| `PINATA_JWT`, `NEXT_PUBLIC_IPFS_GATEWAY` | uploads, metadata, the `/api/ipfs` proxy |
| `FAUCET_PRIVATE_KEY`, `FAUCET_ADDRESS` | Sepolia faucet (also sends the auto-`graduate()`) |

Optional: `DATABASE_URL_UNPOOLED` (migrations), `DATABASE_SSL`,
`DATABASE_POOL_MAX`, `JUNO_FACTORY_BLOCK_<chainId>` (indexer start; else
`factoryBlock` in the address book, else found by bisecting `eth_getCode`),
`JUNO_INITIAL_MCAP_ETH[_<chainId>]` (post launch size; default 0.02 ETH on
Sepolia, 1.0 on One), `JUNO_INDEX_SECRET` (required header
`x-juno-index-secret` on `POST /api/juno/index`), `JUNO_INDEX_INTERVAL_MS`
(in-process indexer poll, e.g. `30000`), `JUNO_AUTO_GRADUATE=0` (turn off the
server's graduate-after-fill). Test/dev only: `JUNO_LOCAL_ADDRESSES`, `JUNO_TEST_PRIVATE_KEY`,
`JUNO_API`, `DEPLOYER_PRIVATE_KEY` (demo `--funder deployer`, read from `../.env`).

## Routes

All JSON, CORS-open, errors as `{ error, …extra }` (4xx the user can act on,
503 "RPC busy" or "not deployed", 500 ours). `chainId` is an optional query
param or body field everywhere; it defaults to `APP_CHAIN_ID`. Addresses are
accepted in any case and returned lowercase.

**Reads**

| Route | Notes |
|---|---|
| `GET /api/health` | Postgres, Mongo, RPC per chain, indexer cursor/lag, faucet balance |
| `GET /api/juno/coins?sort=marketCap\|graduating\|volume&kind=post\|stock&nav=1&social=1&viewer=` | `{ chainId, coins: Coin[], missing }` |
| `GET /api/juno/coins/[address]` | token or curve → `{ coin, activity, crowd, holders, holdersSource, launchTxHash, launchUrl, … }` |
| `GET /api/juno/feed?following=` | trades (indexed) + posts, newest first |
| `GET /api/juno/depth?token=&side=&max=&impact=` | curve's own quote views over log-spaced sizes (one multicall) |
| `GET /api/juno/leaderboard` | realised-P&L ranking from recorded trades |
| `GET /api/juno/portfolio/[wallet]` | balances (multicall) + average-cost basis from the wallet's trades |
| `GET /api/juno/stocks` | plain array `[{ symbol, name, feed, price, updatedAt, ageSeconds, marketOpen, trackers: Coin[] }]` |
| `GET /api/juno/tx/balance?wallet=&token=` | `{ eth, usdc, token? }` |
| `GET /api/juno/index` | `{ lastBlock, latest, lag, curves, trades }` |
| `GET /api/juno/faucet` | faucet address, balance, amounts |
| `GET /api/ipfs/[cid]` | gateway fail-over proxy with Range |

**Builds** — each returns `{ chainId, steps: [{ label, to, data, value, gas }], quote }`.
Every step is simulated from the sender first (a revert comes back as a 400 in
the app's words, with `reason`: `MarketClosed`, `OutsideBand`, `Slippage`,
`Expired`, `AlreadyGraduated`, `SoldOut`, `NotCreator`, `InsufficientFunds`, …),
balances are checked against value + `gas × maxFeePerGas`, and `gas` is the
estimate ×1.3 (`graduate()`: max(×1.5, 3,000,000), because the nested Uniswap
mint starves under the 63/64 rule). A USDC buy behind a pending approve is not
simulated; its gas is estimated with a state override of the allowance.

| Route | Body |
|---|---|
| `POST /api/juno/tx/launch` | `{ creator, name, symbol, metadataUri, format, preset: content\|thin-name\|ipo-book, initialBuy?, capMultiple? }` |
| `POST /api/juno/tx/swap` | `{ curve, trader, side, amountIn? \| amountOut?, slippageBps? }` — quote includes `bandOk`, `marketOpen`, `bandBps`, `refPrice`, `fillsCurve` |
| `POST /api/juno/tx/claim` | `{ curve, creator }` |
| `POST /api/juno/tx/graduate` | `{ curve, caller }` |
| `POST /api/juno/tx/record` | `{ txHash }` → `{ ok, status, launched?: { token, curve }, trades, claims, graduations, autoGraduated? }` |
| `POST /api/juno/index?batches=` | runs the indexer (idempotent; cron-safe) |

**Social, media, faucet**

`comments` (GET `?coin=`, POST `{ coin, wallet, body, side?, txHash|signature? }`),
`likes` (GET `?coins=a,b&viewer=`, POST `{ coin, wallet, like }`),
`follow`, `saved`, `watchlist`, `plans` (GET/POST/PATCH/DELETE), `posts`,
`posts/[id]`, `profiles` (GET `?wallets=`, POST `{ wallet, name, issuedAt,
signature }` — EIP-191 over exactly
`Juno name: ${name}\nWallet: ${lowercaseAddress}\nIssued: ${issuedAt}`, 10-minute
window, ERC-1271 fallback), `upload` (multipart `file`; video gets a pinned
poster), `metadata` (pins `{ name, symbol, description, image, animation_url?,
external_url, properties: { format, creator, mimeType, width, height } }`),
`faucet` (POST `{ wallet }` → `{ eth, usdc }`; 0.02 ETH + 1,000 test USDC,
Sepolia only; 1/wallet and 3/IP per 24h → 429 with `retryAfterSeconds`; 503
below 0.03 ETH).
Unknown `/api/*` paths answer a JSON 404.

## How the pieces fit

- `lib/juno/indexer.ts` — `getLogs` for `Launched` (factory) and
  `Trade`/`CreatorFeesClaimed`/`Graduated`/`LpFeesCollected` (every known
  curve), ≤5,000-block batches (halved on range errors), 20-block re-scan,
  upserts keyed by (tx hash, log index). New curves read name/symbol from the
  token and media/format from the metadata JSON (retried until fetched).
- `lib/juno/events.ts` — pure log → row decoding; only logs from the factory
  or a known curve count, which is what keeps `tx/record` honest.
- `lib/juno/chain.ts` — `hydrateCurves`: `state()` for every curve in one
  multicall, trades in one query, Chainlink for trackers and ETH/USD (Arbitrum
  One feed, used for both chains). Market cap = price × supply.
- `lib/juno/tx.ts` — builders, error copy, gas; `lib/juno/record.ts` —
  receipts, plus graduate-after-fill on Sepolia.
- Units: `Coin.marketCapChangePct` is a ratio; `nav.deviationPct` is a percent
  (1.2 = +1.2%). `Coin.pool` is the curve; `Coin.address` the token.
