# Demo film

The film keeps the STOCKLANA film's approved layout (dark stage, the phone
alternating sides over a lime disc, typed titles, word-lit captions, music
about 12 dB under the voice). Everything on screen is real: the phone chapters
are recordings of the live web app against Arbitrum Sepolia, the terminal
chapters show the repo's proof scripts' actual output, and the browser chapter
is the verified factory on Blockscout.

| Chapter | Kind | Shows |
|---|---|---|
| intro / problem | cards | the feed on a phone; the problem |
| c01 Every post is a market | phone | the live feed |
| c02 Creators get paid | phone | the SMOKE market: its buy, sell and claimed creator fees |
| c03 Held to Chainlink | phone | the Stocks tab with the TSLA tracker |
| c04 The band lives in the contract | phone | the band card; the sheet quoting $500 and refusing $9,500 |
| c05 Refused by the contract | terminal | smoke test: in-band buy confirmed, `OutsideBand(361672101, 357535000, 100)` |
| c06 Graduation to Uniswap v3 | phone | the graduated GRAD market, holders and details |
| c07 Curve maths in Stylus | terminal | 720 calls Stylus == Solidity; `stylus-match.sh` MATCH |
| c08 Verified, end to end | browser | the factory's exact-match verification |

Sign-in, posting and Arbitrum One are not in this cut: they need a Privy
sign-in and test ETH for real footage. Add them as phone chapters when they
can be recorded.

## Build

```bash
# 1. footage (Playwright + its chrome-headless-shell; the live app)
node scripts/demo/record-web.mjs .juno/video/raw          # c01–c04, c06
#    c08: a 1440x900 recording of the explorer page, saved as .juno/video/raw/08-explorer.mp4

# 2. voice + word timings for the captions
python3 scripts/demo/vo_local.py .juno/video/final/vo     # Kokoro + hyperframes transcribe, no key
#    or, with a key: ELEVENLABS_API_KEY=… python3 scripts/demo/vo_eleven.py .juno/video/final/vo
for f in .juno/video/final/vo/*.wav; do cp "$f" .juno/video/final/hf/assets/audio/vo-$(basename "$f"); done

# 3. clips, composition, render, final mix
python3 scripts/demo/clips.py .juno/video/final/hf .juno/video/final/vo
python3 scripts/demo/build_hf.py .juno/video/final/hf .juno/video/final/vo
(cd .juno/video/final/hf && npx hyperframes check && npx hyperframes render -o ../film-render.mp4)
python3 scripts/demo/remix.py .juno/video/final/hf .juno/video/final/film-render.mp4 juno-arbitrum-film.mp4
```

The HyperFrames project in `.juno/video/final/hf` also needs `fonts/`,
`assets/phone-frame.png`, `assets/audio/music-bed.wav` (the ElevenLabs bed from
the STOCKLANA film) and live stills (`hero-screen.png`, `card-*.png`).
