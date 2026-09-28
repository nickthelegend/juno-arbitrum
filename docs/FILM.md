# Demo film: shot list and build

The film keeps the STOCKLANA film's approved layout (dark stage, the phone
alternating sides over a lime disc, typed titles, word-lit captions, music
about 12 dB under the voice). The tooling is in `scripts/demo/`; the narration
is `scripts/demo/vo.py` (`LINES`), the chapter cards `scripts/demo/build_hf.py`
(`CHAPTERS`). Target length: about 3.7 minutes.

## 1. Record (iOS Simulator, iPhone 17)

Record each take with `xcrun simctl io booted recordVideo <file>.mp4`, then
frame it with `bash scripts/demo/frame-video.sh`. Framed takes go in
`.juno/video/full/`, bare simulator recordings in `.juno/video/raw/`.

| Chapter | File | What to show |
|---|---|---|
| c01 | `raw/01-wallet-privy.mp4` | Profile → Continue with email → OTP → wallet appears → faucet → claim a name |
| c02 | `02-feed-buy.mp4` | Feed → Buy on a demo post → amount → confirm → receipt with the Arbiscan link |
| c03 | `03-reels.mp4` | Reels tab: swipe two reels, like one, open the buy dock |
| c04 | `04-comments.mp4` | Comments sheet on a demo post: post a comment, count goes up |
| c05 | `05-post-launch-log.mp4` | + → photo → name/ticker → curve shape → launch log receipts (IPFS, launch tx, curve, listed) |
| c06 | `06-reel-launch-log.mp4` | + → video → same flow, then the reel in the swipe feed |
| c07 | `07-creator-claim.mp4` | The creator's coin page → accrued fees → Claim → receipt |
| c08 | `08-tracker-band.mp4` | Trade → Stocks → TSLA tracker → $500 buy confirms → large buy refused with the OutsideBand message |
| c09 | `09-market-closed.mp4` | A tracker with a stale feed: "Market closed · sells only", buy disabled, a sell succeeds |
| c10 | `10-graduated-uniswap.mp4` | A graduated coin page → "Trading on Uniswap" → the pool |
| c11 | `11-stylus.mp4` | The Stylus CurveMath program on Arbiscan, then `scripts/stylus-match.sh` printing MATCH |
| c12 | `12-arbitrum-one-proof.mp4` | The Arbitrum One factory, TSLA tracker and trades on Arbiscan (after `scripts/mainnet-proof.ts`) |

Stock trackers need an open market. Outside US market hours, run the
`feeds` workflow with `force_open` before recording c08, and say on screen
that the Sepolia feeds are mocks mirroring the real Arbitrum One prices.
For c09, record on a weekend or wait 26 hours after the last feed update.

## 2. Voice, music, captions

```bash
ELEVENLABS_API_KEY=… python3 scripts/demo/vo_eleven.py .juno/video/final/vo11
ELEVENLABS_API_KEY=… python3 scripts/demo/music_eleven.py .juno/video/final/hf/assets/audio/music-bed.wav 240
```

`vo_eleven.py` writes the per-word timings the captions use. Without a key,
`python3 scripts/demo/vo.py .juno/video/final/vo` makes a local Kokoro voice
(no captions).

## 3. Build and render

```bash
python3 scripts/demo/clips.py .juno/video/final/hf .juno/video/final/vo11
python3 scripts/demo/build_hf.py .juno/video/final/hf .juno/video/final/vo11
npx hyperframes render .juno/video/final/hf
python3 scripts/demo/remix.py .juno/video/final/hf film.mp4 juno-arbitrum.mp4
```
