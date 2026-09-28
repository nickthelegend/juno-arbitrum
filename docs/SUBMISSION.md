# HackQuest submission — Arbitrum Open House Singapore (online buildathon)

Deadline assumed: **Sun 4 Oct 2026, 23:59 SGT**. Submit by Sat 3 Oct.
Paste the real form's fields here once you have them (they weren't visible on
the public page).

| Field | Value |
|---|---|
| Project | Juno — every post is a market |
| One-liner | Post a photo or reel and it launches its own bonding curve on Arbitrum; creators earn every trade; stock trackers held to Chainlink prices on-chain. |
| Track | General (novel financial applications on Arbitrum) |
| Repo | https://github.com/nickthelegend/juno-arbitrum |
| Live app | https://juno-arb-app.vercel.app (Arbitrum Sepolia) |
| API | https://juno-arb-api.vercel.app/api/health |
| Demo video | [YouTube unlisted link — record after the Sepolia deploy] |
| Pitch deck | [link — export the Slides artifact as PDF] |
| Contracts (Sepolia) | [from config/addresses.ts after `bash scripts/deploy.sh`] |
| Contracts (Arbitrum One) | [after `CHAIN=one bash scripts/deploy.sh` + `npx tsx scripts/mainnet-proof.ts`] |
| Builds | GitHub release: Android APK, iOS Simulator build |

## What's built on Arbitrum
- **Stylus** `CurveMath` (Rust→WASM) prices every trade; Solidity `JunoCurve`
  calls it. Bit-for-bit with a Solidity spec, checked by a differential test.
- **Chainlink** equity feeds + L2 sequencer uptime feed hold stock trackers to
  a band inside the contract (buys past the band revert `OutsideBand`; stale
  feed → sells only).
- **Uniswap v3** graduation into a pool created and priced at launch; the
  position NFT is locked in the curve.
- **Privy** embedded EVM wallets on iOS, Android and web.

## Judging criteria
- **Smart contract quality** — 31 Foundry tests on an Arbitrum One fork, 4
  invariants × 8,192 random trades, 97–100% line coverage, Slither triaged
  (docs/SECURITY.md), Rust property tests for the Stylus maths.
- **Product-market fit / real problem** — creators monetise attention directly,
  early fans own a piece; dollar-priced stock exposure held honest by an oracle.
- **Innovation** — an oracle band enforced inside a bonding curve; the curve
  shape as a product decision (four fixed presets).
