# Juno on Arbitrum: server ↔ app contract

Every route lives under `/api/juno/` and answers JSON. This file lists the
EVM-specific parts of the contract: chains, addresses, transaction builders,
signatures and errors. Response shapes are defined by the route handlers in
`server/app/api/juno/**` and consumed by `app/lib/api.ts`.

## Chains

| Name | chainId | Explorer | Role |
|---|---|---|---|
| Arbitrum Sepolia | 421614 | https://sepolia.arbiscan.io | the app's network (`APP_CHAIN_ID`, `EXPO_PUBLIC_CHAIN_ID`) |
| Arbitrum One | 42161 | https://arbiscan.io | mainnet proof only |

- Addresses are 0x-prefixed, 40 hex characters.
- The server stores and compares them **lowercased** and returns them lowercased.
- The app checksums them only for display (`getAddress` from viem).
- `cluster` fields and query params become `chainId: number`.

## Contracts (see `config/abi.ts`, `config/addresses.ts`)

- `JunoFactory`: `launch`, `launchTracker`, event `Launched`.
- `JunoCurve`, one per coin:
  - `buy(minOut, deadline)` payable for ETH;
  - `buyWithQuote(amountIn, minOut, deadline)` for ERC-20 quotes (USDC), which needs an `approve` first;
  - `buyExactOut(amountOut, maxIn, deadline)`;
  - `sell(amountIn, minOut, deadline)`, which needs **no approve**, because the token lets its own curve pull;
  - `claimCreatorFees()`, `graduate()`, `collectLpFees()`;
  - views `state()`, `quoteBuy(amountIn)`, `quoteBuyExactOut(amountOut)`, `quoteSell(amountIn)`;
  - events `Trade`, `CreatorFeesClaimed`, `Graduated`, `LpFeesCollected`.
- `CurveMath`: a Stylus (Rust) contract holding the pure pricing maths. The curves call it.

Reverts the app must decode and explain:

| Error | App copy |
|---|---|
| `MarketClosed(uint256 updatedAt, uint256 maxAge)` | "Market closed — the stock price is stale, so buys are paused. You can still sell." |
| `OutsideBand(uint256 priceAfter, uint256 refPrice, uint16 bandBps)` | "This buy would push the price more than X% above the stock. Try a smaller amount." |
| `Slippage(uint256 got, uint256 limit)` | "The price moved. Try again or raise slippage." |
| `Expired()` | "Took too long to sign. Try again." |
| `AlreadyGraduated()` | "This market moved to Uniswap." |
| `SoldOut()` | "Curve is full — graduating." |
| `NotCreator()` | (hidden button, never shown) |

## Field renames in responses

- `Coin.address` is the **token address** (the canonical id; route `/coins/[address]`).
- `Coin.pool` is the **curve contract address**.
- `Coin.config` is removed.
- `Coin.quote` is `{ address: string | null, symbol: "ETH" | "USDC", decimals: 18 | 6 }`. `address: null` means native ETH. It replaces `quote.mint`.
- `Coin.reference` is `{ source: "chainlink", id: "TSLA" | "NVDA" | "AAPL", feed: "0x…" } | null`.
- `Coin.nav` for trackers is `{ source: "chainlink", symbol, price, updatedAt, ageSeconds, bandBps, marketOpen: boolean, curvePrice, deviationPct }`.
- `Coin.graduatedPool` is the Uniswap v3 pool address, once graduated.
- `Coin.chainId`: number.
- Activity/trade rows use `txHash` in place of `signature`, and add `logIndex` and `blockNumber`.

## Building transactions

`POST /api/juno/tx/launch | tx/swap | tx/claim | tx/graduate` returns:

```json
{
  "chainId": 421614,
  "steps": [
    { "label": "Approve USDC", "to": "0x…", "data": "0x…", "value": "0" },
    { "label": "Buy", "to": "0x…", "data": "0x…", "value": "0" }
  ],
  "quote": { "...": "route-specific, same fields as before" }
}
```

- `value` is a decimal string in wei.
- The app sends the steps **in order** with Privy's `eth_sendTransaction`, waiting for each receipt before sending the next.
- After the last receipt, the app calls `POST /api/juno/tx/record { chainId, txHash }`. The server reads the receipt, records any `Launched` or `Trade` logs at once (the indexer also catches them), and returns `{ ok, launched?: { token, curve }, trades: n }`. This replaces `tx/submit`: the device sends the transaction itself.

**Swap request:**
```json
{ "chainId", "curve", "trader", "side": "buy"|"sell",
  "amountIn"?: "decimal string, UI units", "amountOut"?: "decimal string, tokens (exact-out buy)",
  "slippageBps"?: 100 }
```

**Launch request:**
```json
{ "chainId", "creator", "name", "symbol", "metadataUri", "format": "post"|"reel",
  "preset": "content"|"thin-name"|"ipo-book",
  "initialBuy"?: "ETH decimal string" }
```
- Tracker launches go through `launchTracker` and are made by `scripts/`, not the app.

## Wallet sessions (social writes)

Every write stored against a wallet needs proof the caller controls it:
`POST likes`, `comments`, `follow`, `watchlist`, `plans` (and `PATCH`/`DELETE`
by the plan's owner), `posts`, `upload` and `metadata`.

1. The wallet signs, with EIP-191 `personal_sign`, exactly
   `Juno session\nWallet: ${lowercaseAddress}\nIssued: ${isoTime}`.
2. `POST /api/juno/session { chainId, wallet, issuedAt, signature }` →
   `201 { token, wallet, expiresAt }` (accepted within 10 minutes of `issuedAt`;
   valid 7 days; ERC-1271/6492 smart wallets verified on-chain).
3. Writes send `Authorization: Bearer <token>`. No or expired token → `401
   {reason:"NoSession"}`; a token for another wallet than the write names →
   `403 {reason:"WrongWallet"}`. `GET /api/juno/session` echoes the session.

Name claims (`POST profiles`) keep their own per-claim signature; a signature
from another wallet is `401 {reason:"BadSignature"}`.

`tx/swap` also takes `quoteOnly: true` (no `trader`): the quote with no steps
and no balance checks, for visitors; the band and staleness checks still run.
A refusal there is `200 { quote: null, steps: [], refusal: { message, reason } }`.
A signed-in caller quoting as the user types sends `refusalAsAnswer: true` to get
the same shape (with the balance checks too) instead of a 400.

## Other changes

- **Faucet:** `POST /api/juno/faucet { wallet, chainId }` sends 0.02 ETH plus 1,000 Juno test USDC on test networks only (Sepolia, and the local node). It returns `{ eth: txHash, usdc: txHash | null }`, 429 with `retryAfterSeconds` when rate-limited, and 503 when the faucet is empty.
- **Balance:** `GET /api/juno/tx/balance?wallet&chainId` returns `{ eth: number, usdc: number, tokens?: … }`.
- **Profiles:** name claims are signed with EIP-191 (`personal_sign`) over exactly
  `Juno name: ${name}\nWallet: ${lowercaseAddress}\nIssued: ${isoTime}`.
  The server runs `verifyMessage` and accepts it only within 10 minutes of `Issued`. The signature is a 0x hex string.
- **Stocks:** `/api/juno/stocks` replaces `/api/juno/tessera`. It returns the Chainlink references `[{ symbol, name, feed, price, updatedAt, ageSeconds, marketOpen, trackers: Coin[] }]`.
- **Pre-IPO** and every Tessera route are removed.
