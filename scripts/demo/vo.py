"""
Voiceover for the Juno product demo, one clip per chapter, with Kokoro TTS
(male voice `am_michael`). Writes vo/<id>.wav and vo/durations.json.

    python3 scripts/demo/vo.py .juno/video/final/vo
"""
import json
import sys

import soundfile as sf
from kokoro_onnx import Kokoro

MODEL = "/Volumes/Extreme SSD/Projects/swipe-fit/.cache/kokoro/kokoro-v1.0.onnx"
VOICES = "/Volumes/Extreme SSD/Projects/swipe-fit/.cache/kokoro/voices-v1.0.bin"
VOICE = "am_michael"

LINES = {
    "intro": "This is Juno. Every post is a market, on Arbitrum.",
    "problem": "Today, creators get paid by platforms, months later, in ad money. The fans who found them first get nothing. On Juno, every post is its own market, and the creator earns on every trade.",
    "c01": "Sign in with your email, and Privy creates an Ethereum wallet for you. No seed phrase, nothing to install. The faucet sends test ETH on Arbitrum Sepolia, and you claim a name with a signed message.",
    "c02": "The feed is made of posts, and every post has a price. Tap buy, pick an amount, and the quote comes straight from the curve contract. Confirmed on Arbitrum in about a second, with the receipt on Arbiscan.",
    "c03": "Reels work the same way. Full screen video, with the market right under the caption. Market cap, progress to graduation, buy and sell, one tap away.",
    "c04": "Likes and comments come from real wallets. Every count on screen is stored, and every name is claimed with a signature.",
    "c05": "Posting is launching. Pick a photo, give it a name and a ticker, and choose a curve shape. Juno pins it to IPFS, and one transaction to the factory deploys the token and its curve. You watch every step land, with its hash and the second it confirmed.",
    "c06": "A reel is the same flow, with a video. Pinned with a poster frame, launched in one transaction, and straight into the swipe feed.",
    "c07": "And this is the point. Every trade pays the creator half the fee. They claim it right from the coin page, and the contract only lets the creator do it.",
    "c08": "Juno also issues stock trackers. Each one is a curve held to its stock's Chainlink price, inside the contract. A buy inside the band goes through. A buy that would push the price more than one percent above Tesla is refused by the contract itself, and the app tells you why.",
    "c09": "When the feed goes stale, like on a weekend, the market reads as closed. Buys are refused, and sells always stay open.",
    "c10": "When a curve fills, anyone can graduate it. The contract moves the tokens and the ETH it raised into a Uniswap v3 pool, locks the position, and trading carries on there.",
    "c11": "Under every trade is Juno's curve maths, written in Rust for Stylus. The same program runs the four curve shapes, and it matches a Solidity reference on every call we tested.",
    "c12": "And it isn't just testnet. The same contracts are live on Arbitrum One, with a Tesla tracker held to the real Chainlink feed. Every address is in the README, verified on chain.",
    "stack": "Under the hood, one Expo app runs on iOS, Android and the web. The server builds every transaction, and your Privy wallet signs it. Solidity runs the launchpad, Stylus runs the maths, Chainlink supplies the stock prices, and Uniswap takes over at graduation.",
    "outro": "Juno. Every post is a market. Built on Arbitrum.",

}

if __name__ == "__main__":
    out = sys.argv[1]
    kokoro = Kokoro(MODEL, VOICES)
    durations = {}
    only = set(sys.argv[2].split(",")) if len(sys.argv) > 2 else None
    old = json.load(open(f"{out}/durations.json")) if only else {}
    durations.update(old)
    for key, text in LINES.items():
        if only and key not in only:
            continue
        samples, rate = kokoro.create(text, voice=VOICE, speed=1.22, lang="en-us")
        sf.write(f"{out}/{key}.wav", samples, rate)
        durations[key] = round(len(samples) / rate, 2)
        print(key, durations[key])
    json.dump(durations, open(f"{out}/durations.json", "w"), indent=1)
