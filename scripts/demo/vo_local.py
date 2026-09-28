"""
Voiceover without an API key: Kokoro TTS on this machine, word timings from
`hyperframes transcribe`, aligned back onto the script's own words so the
captions read exactly as written. Writes <out>/<id>.wav, <id>.words.json
({w, s, e} per word, the shape vo_eleven.py writes) and durations.json.

    python3 scripts/demo/vo_local.py .juno/video/final/vo [c01,c05]

Use vo_eleven.py instead when ELEVENLABS_API_KEY is available.
"""
import difflib
import json
import os
import re
import subprocess
import sys

import soundfile as sf
from kokoro_onnx import Kokoro

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from vo import LINES, MODEL, VOICE, VOICES  # noqa: E402

out = sys.argv[1]
only = set(sys.argv[2].split(",")) if len(sys.argv) > 2 else None
os.makedirs(out, exist_ok=True)
kokoro = Kokoro(MODEL, VOICES)


def norm(word):
    return re.sub(r"[^a-z0-9]", "", word.lower())


def transcribe(wav):
    """Word timings heard in the audio: [{"w", "s", "e"}]."""
    result = subprocess.run(
        ["npx", "--yes", "hyperframes@0.8.86", "transcribe", wav, "--json", "--language", "en", "--dir", out],
        capture_output=True, text=True, check=True,
    )
    data = json.loads(result.stdout[result.stdout.index("{"):])
    # The CLI reports where it wrote the words: a list of {text, start, end}.
    words = json.load(open(data["transcriptPath"]))
    heard = []
    for w in words:
        text = (w.get("text") or w.get("word") or "").strip()
        start, end = w.get("start", w.get("s")), w.get("end", w.get("e"))
        if text and start is not None:
            heard.append({"w": text, "s": float(start), "e": float(end)})
    return heard


def align(script_words, heard):
    """Give each script word the timing of the word heard for it; interpolate the rest."""
    a = [norm(w) for w in script_words]
    b = [norm(h["w"]) for h in heard]
    timed = [None] * len(script_words)
    for block in difflib.SequenceMatcher(a=a, b=b, autojunk=False).get_matching_blocks():
        for k in range(block.size):
            h = heard[block.b + k]
            timed[block.a + k] = (h["s"], h["e"])
    end = heard[-1]["e"] if heard else 0.5 * len(script_words)
    i = 0
    while i < len(timed):
        if timed[i] is not None:
            i += 1
            continue
        j = i
        while j < len(timed) and timed[j] is None:
            j += 1
        lo = timed[i - 1][1] if i > 0 else 0.0
        hi = timed[j][0] if j < len(timed) else end
        step = max(hi - lo, 0.05) / (j - i)
        for k in range(i, j):
            timed[k] = (lo + (k - i) * step, lo + (k - i + 1) * step)
        i = j
    return [{"w": w, "s": round(s, 3), "e": round(e, 3)} for w, (s, e) in zip(script_words, timed)]


path = f"{out}/durations.json"
durations = json.load(open(path)) if os.path.exists(path) else {}
for key, text in LINES.items():
    if only and key not in only:
        continue
    samples, rate = kokoro.create(text, voice=VOICE, speed=1.15, lang="en-us")
    wav = f"{out}/{key}.wav"
    sf.write(wav, samples, rate)
    words = align(text.split(), transcribe(wav))
    json.dump(words, open(f"{out}/{key}.words.json", "w"))
    durations[key] = round(len(samples) / rate, 2)
    matched = sum(1 for w in words)
    print(key, durations[key], f"{matched} words")
json.dump(durations, open(path, "w"), indent=1)
