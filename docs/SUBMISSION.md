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
| Demo video | [YouTube unlisted link — shot list and build steps in docs/FILM.md] |
| Pitch deck | [link — export the Slides artifact as PDF] |
| Contracts (Sepolia) | Stylus CurveMath `0x5125c9E14B64aCd48Bf7116A93c9B66DF89A4F37` · JunoFactory `0xBc89E74A36a9EFf7B938211ea4B82650DA3BE87a` · JunoCurve impl `0x3a4A8c33D8a3BacA2B58d608107a6E1Aa2B9A9F1` (Solidity verified on Sourcify; Stylus rebuilt byte for byte) |
| Contracts (Arbitrum One) | [after `CHAIN=one bash scripts/deploy.sh` + `npx tsx scripts/mainnet-proof.ts`] |
| Builds | https://github.com/nickthelegend/juno-arbitrum/releases/tag/v0.1.0 (Android APK, iOS Simulator build) |

## What's built on Arbitrum
- **Stylus** `CurveMath` (Rust→WASM) prices every trade; Solidity `JunoCurve`
  calls it. Matched a Solidity spec on 720 of 720 live calls; the deployed
  initcode rebuilds byte for byte from the repo (`scripts/stylus-match.sh`).
- **Chainlink** equity feeds + L2 sequencer uptime feed hold stock trackers to
  a band inside the contract (buys past the band revert `OutsideBand`; stale
  feed → sells only).
- **Uniswap v3** graduation into a pool created and priced at launch; the
  position NFT is locked in the curve. Done live on Sepolia (position #3803).
- **Privy** embedded EVM wallets on iOS, Android and web.

## Judging criteria
- **Smart contract quality** — 31 Foundry tests on an Arbitrum One fork, 4
  invariants × 8,192 random trades, 97–100% line coverage, Slither triaged
  (docs/SECURITY.md), Rust property tests for the Stylus maths.
- **Product-market fit / real problem** — creators monetise attention directly,
  early fans own a piece; dollar-priced stock exposure held honest by an oracle.
- **Innovation** — an oracle band enforced inside a bonding curve; the curve
  shape as a product decision (four fixed presets).
