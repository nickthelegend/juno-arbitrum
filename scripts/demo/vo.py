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
    "c01": "This is the Juno app on iPhone, live on Arbitrum Sepolia. Every post in the feed is its own token and bonding curve: its price, who bought, and how close it is to graduating. Reels too, each one a coin.",
    "c02": "Sign in with an email. Privy creates an Arbitrum wallet, with no seed phrase. The faucet sends test ETH and test dollars, and that transfer is real, on chain.",
    "c03": "Now post. Pick a photo, give it a name and a ticker, and launch. The photo goes to IPFS, and one transaction to the factory deploys the token and its curve. It is live in the feed.",
    "c04": "Buying is one sheet. The server quotes it against the curve, the wallet signs, and the receipt comes from the chain itself, with a link to the transaction on Arbiscan.",
    "c05": "Stock trackers are held to Chainlink. The contract reads the Nvidia feed on every buy and refuses one that would leave a one percent band, and the sheet shows how much fits before you sign. Ten dollars approves the USDC and goes through.",
    "c06": "When a curve fills, it graduates. The contract moves its liquidity into a Uniswap v3 pool and locks it forever. This one trades on Uniswap now.",
    "c07": "Under every price is Juno's curve maths, written in Rust for Arbitrum Stylus. The deployed program matched a Solidity reference on seven hundred and twenty calls, and it rebuilds from the source, byte for byte.",
    "c08": "And every step you just saw is a real transaction on Arbitrum Sepolia. The launch that created the token and its curve, the TWIST buy, and the Nvidia tracker buy in USDC. Anyone can check them.",
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
