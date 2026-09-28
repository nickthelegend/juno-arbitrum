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
    "c01": "Every post on Juno is its own token and bonding curve, launched with one call to the factory contract. The feed shows each market live: its price, who bought, and how close it is to graduating.",
    "c02": "And every trade pays the creator. Half of each fee builds up in the curve for them, and only the creator can claim it. This creator already has, on Arbitrum Sepolia.",
    "c03": "Juno also issues stock trackers. Each one is a curve priced in dollars and held to its stock's Chainlink price. Tesla, Nvidia and Apple, with the price, how fresh it is, and whether the market is open.",
    "c04": "The band lives in the contract. Every buy reads the Chainlink price. Five hundred dollars goes through. Ninety five hundred would lift the curve more than one percent above Tesla, so the quote says no before you ever sign.",
    "c05": "And the contract enforces it. On Sepolia, the small buy confirmed, and the big one reverted with Outside Band: the curve price, the Chainlink price, and the band.",
    "c06": "When a curve fills, anyone can graduate it. The contract moves the tokens and the ETH it raised into a Uniswap v3 pool, and locks the position forever. This one graduated on Sepolia.",
    "c07": "Under every price is Juno's curve maths, written in Rust for Arbitrum Stylus. The deployed program matched a Solidity reference on seven hundred and twenty calls, and it rebuilds from the source, byte for byte.",
    "c08": "Every contract is verified, and every step you just saw is a real transaction on Arbitrum Sepolia.",
    "stack": "Under the hood, one Expo app runs on iOS, Android and the web. The server builds every transaction, and a Privy wallet signs it. Solidity runs the launchpad, Stylus runs the maths, Chainlink supplies the stock prices, and Uniswap takes over at graduation.",
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
