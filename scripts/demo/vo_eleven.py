"""
Voiceover for the Juno demo with ElevenLabs, plus word timings for subtitles.

    ELEVENLABS_API_KEY=... python3 scripts/demo/vo_eleven.py .juno/video/final/vo11

Uses the same narration as vo.py. For each line it calls the
`with-timestamps` endpoint, writes <key>.mp3, and turns the character
alignment into word timings (<key>.words.json) for the burned-in captions.
The key is read from the environment and never written anywhere.
"""
import base64
import json
import os
import sys
import urllib.request

sys.path.insert(0, os.path.dirname(__file__))
from vo import LINES  # noqa: E402  (the narration lives in one place)

VOICE = "JBFqnCBsd6RMkjVDRZzb"
MODEL = "eleven_multilingual_v2"
KEY = os.environ["ELEVENLABS_API_KEY"]
out = sys.argv[1]
only = set(sys.argv[2].split(",")) if len(sys.argv) > 2 else None
os.makedirs(out, exist_ok=True)


def words_from(alignment):
    chars = alignment["characters"]
    starts = alignment["character_start_times_seconds"]
    ends = alignment["character_end_times_seconds"]
    words, current, w_start, w_end = [], "", None, None
    for ch, s, e in zip(chars, starts, ends):
        if ch.isspace():
            if current:
                words.append({"w": current, "s": round(w_start, 3), "e": round(w_end, 3)})
            current, w_start = "", None
            continue
        if w_start is None:
            w_start = s
        current += ch
        w_end = e
    if current:
        words.append({"w": current, "s": round(w_start, 3), "e": round(w_end, 3)})
    return words


durations = {}
for key, text in LINES.items():
    if only and key not in only:
        continue
    body = json.dumps(
        {
            "text": text,
            "model_id": MODEL,
            "voice_settings": {"stability": 0.5, "similarity_boost": 0.8, "style": 0.15, "speed": 1.2},
        }
    ).encode()
    request = urllib.request.Request(
        f"https://api.elevenlabs.io/v1/text-to-speech/{VOICE}/with-timestamps?output_format=mp3_44100_128",
        data=body,
        headers={"xi-api-key": KEY, "Content-Type": "application/json"},
    )
    response = json.load(urllib.request.urlopen(request, timeout=120))
    open(f"{out}/{key}.mp3", "wb").write(base64.b64decode(response["audio_base64"]))
    words = words_from(response.get("normalized_alignment") or response["alignment"])
    json.dump(words, open(f"{out}/{key}.words.json", "w"))
    durations[key] = round(words[-1]["e"] + 0.15, 2)
    print(key, durations[key], len(words), "words")

previous = {}
path = f"{out}/durations.json"
if os.path.exists(path):
    previous = json.load(open(path))
previous.update(durations)
json.dump(previous, open(path, "w"), indent=1)
