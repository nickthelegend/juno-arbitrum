# Juno contracts: security notes

These contracts have not been audited. This file records what they assume,
what they guard against, what they don't, and how the static-analysis
findings were triaged.

## Trust model

| Party | Can | Cannot |
|---|---|---|
| Factory owner | allowlist quote tokens and Chainlink feeds; set the treasury | change presets, fees, supply, or any launched curve; move anyone's funds |
| Creator | claim their half of trading and LP fees | trade on better terms; stop trading; withdraw the reserve |
| Anyone | buy, sell, graduate a full curve, collect a graduated position's LP fees (paid to creator + treasury), push protocol fees to the treasury | — |
| `CurveMath` (Stylus) | price every trade | hold funds (stateless, pure) |
| Chainlink feed | decide whether a tracker buy is in band / market open | block sells |

The four presets are written in the factory's constructor and have no setter.
Every curve copies its parameters at `initialize` (EIP-1167 clones of an
implementation whose own initializer is disabled).

## Protections

- **Solvency.** A curve's quote balance always covers `quoteReserve +
  creatorFees + protocolFees`, and `quoteReserve` always covers selling back
  every token sold (`proceedsToSell(sold, sold)`). Buy costs round up and
  sell proceeds round down, per segment, so a round trip cannot extract
  value. These are enforced by Foundry invariant and fuzz tests
  (`contracts/test/Juno.t.sol`) and by the Rust property tests.
- **Reentrancy.** Every state-changing entry point is `nonReentrant`
  (transient-storage guard, EIP-1153), and state is written before external
  calls (checks-effects-interactions).
- **Slippage and deadlines.** Every trade takes `minOut`/`maxIn` and a
  `deadline`.
- **Oracle hygiene (trackers).** Buys revert if:
  - the answer is ≤ 0;
  - the feed is older than `maxAge` (26 hours by default, so a weekend or
    holiday closes the market);
  - the Arbitrum sequencer uptime feed reports down, or it restarted less
    than an hour ago (Chainlink's L2 guidance).
  Sells never read the oracle, so a dead or stale feed can't trap holders.
- **Graduation price.** The factory creates the Uniswap v3 pool at launch
  and initializes it at the curve's final price. Until graduation, the token
  refuses transfers into that pool from anyone but the curve. Nobody can
  seed the pool at a different price and have graduation mint into it.
- **Locked liquidity.** The graduated position NFT is owned by the curve,
  which has no function to withdraw liquidity, only to collect fees.

## Known limitations

- **Other pools.** The token can be paired in other Uniswap fee tiers or on
  other DEXes before graduation. Those pools are not Juno's and don't affect
  the curve or its graduation pool.
- **Pre-initialised pool.** If someone created and initialized Juno's exact
  pool (token, quote, fee tier) before the launch transaction, which needs
  the not-yet-deployed token address, `initialize` would revert and the
  launch would fail. Nothing would be lost. This is not reachable in
  practice, because the token is created in the same transaction.
- **Oracle trust.** A tracker is only as honest as its feed. The Sepolia
  deployment uses `MockAggregator`s mirroring the real Arbitrum One feeds.
  This is disclosed in the app and the README.
- **Test tokens.** `TestUSDC` (anyone can mint up to 10,000 per call) exists
  only on Arbitrum Sepolia. Arbitrum One trackers use Circle USDC.
- **Stylus program.** `CurveMath` is deployed with `cargo stylus deploy`.
  Stylus programs must be reactivated about once a year, which anyone can
  do. The Solidity reference `CurveMathRef` is the specification; the two
  are compared by `scripts/diff-curve-math.ts`.

## Slither (0.11.6) triage

Run with:
`slither contracts --filter-paths "lib/|test/|script/|test-helpers/" --exclude-informational --exclude-optimization`

| Detector | Where | Resolution |
|---|---|---|
| missing-zero-check | factory constructor, `setTreasury`, `JunoToken.setPool` | **Fixed**: zero addresses revert (`BadParams` / `PoolSet`). `sequencerFeed` may be zero by design (Sepolia has none). |
| reentrancy-benign | `graduate()` wrote `quoteReserve` after `markGraduated()`; `_deploy` recorded the curve after external calls | **Fixed**: effects moved before interactions. Both are also `nonReentrant` or only touch freshly created contracts. |
| reentrancy-events | `_deploy` emits `Launched` after external calls | Accepted: the calls are to the token and pool created in the same transaction. |
| divide-before-multiply | tick rounding in `graduate()`; `_expNeg` in `CurveMathRef` | Intentional. Ticks must be multiples of the spacing. `_expNeg`'s rounding is the specification the Stylus program reproduces bit for bit. |
| incorrect-equality | `out == 0`, `amount == 0` | Intentional zero-amount guards. |
| unused-return | `latestRoundData` fields, position-manager `liquidity` | Staleness uses `updatedAt` (`answeredInRound` is deprecated); liquidity is read from the pool when needed. |
| timestamp | fee decay, deadlines, oracle age | Intended. The Arbitrum sequencer sets the timestamp, and a few seconds of skew is harmless for these checks. |
| uninitialized-local | loop accumulators in `CurveMathRef` | False positive: Solidity zero-initializes locals. |

No high-severity findings: none for arbitrary-send, reentrancy-eth, locked-ether or unprotected upgrade.
