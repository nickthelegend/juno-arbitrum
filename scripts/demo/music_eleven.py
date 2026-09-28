"""
Background music for the Juno demo, from ElevenLabs Music.

    ELEVENLABS_API_KEY=... python3 scripts/demo/music_eleven.py out.mp3 [seconds]

One instrumental track long enough to run from the end of the cat film to the
end card. Energetic, since the film moves fast; it is mixed well under the
voice later, so it only has to carry pace, not melody. The key is read from
the environment and never written anywhere.
"""
import json
import os
import sys
import urllib.request

PROMPT = (
    "Energetic, upbeat instrumental for a modern tech product launch video. "
    "Driving four-on-the-floor electronic drums, punchy sidechained bass, bright synth plucks "
    "and uplifting chords, about 124 BPM, confident and optimistic. "
    "Steady high energy throughout with small builds every 30 seconds, no vocals, "
    "no long breakdowns, and a clean ending."
)

out = sys.argv[1]
seconds = float(sys.argv[2]) if len(sys.argv) > 2 else 205
body = json.dumps(
    {
        "prompt": PROMPT,
        "music_length_ms": int(seconds * 1000),
        "model_id": "music_v1",
        "force_instrumental": True,
    }
).encode()
request = urllib.request.Request(
    "https://api.elevenlabs.io/v1/music?output_format=mp3_44100_192",
    data=body,
    headers={"xi-api-key": os.environ["ELEVENLABS_API_KEY"], "Content-Type": "application/json"},
)
with urllib.request.urlopen(request, timeout=600) as response:
    open(out, "wb").write(response.read())
print(out, os.path.getsize(out), "bytes")
