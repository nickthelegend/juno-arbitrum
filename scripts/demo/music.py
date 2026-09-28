"""
Background music for the demo, generated with MusicGen (facebook/musicgen-small).

MusicGen writes ~30s per call, so this makes two passes on the same prompt and
the mixer loops them with crossfades to the video's length. Run once:

    python3 scripts/demo/music.py .juno/video/final/audio
"""
import sys

import numpy as np
import soundfile as sf
import torch
from transformers import AutoProcessor, MusicgenForConditionalGeneration

out = sys.argv[1] if len(sys.argv) > 1 else "."
prompt = (
    "minimal premium tech product launch background music, warm analog synth pads, "
    "soft plucked arpeggio, gentle deep bass, light electronic percussion, optimistic, "
    "calm and confident, 100 bpm, clean mix, no vocals"
)
device = "mps" if torch.backends.mps.is_available() else "cpu"
processor = AutoProcessor.from_pretrained("facebook/musicgen-small")
model = MusicgenForConditionalGeneration.from_pretrained("facebook/musicgen-small")
try:
    model = model.to(device)
except Exception:
    device = "cpu"
rate = model.config.audio_encoder.sampling_rate
for i in range(2):
    torch.manual_seed(7 + i)
    inputs = processor(text=[prompt], padding=True, return_tensors="pt").to(device)
    try:
        audio = model.generate(**inputs, do_sample=True, guidance_scale=3.0, max_new_tokens=1500)
    except Exception as error:  # MPS gaps in some ops: fall back to CPU
        print("mps failed, cpu:", error)
        model = model.to("cpu"); device = "cpu"
        inputs = processor(text=[prompt], padding=True, return_tensors="pt")
        audio = model.generate(**inputs, do_sample=True, guidance_scale=3.0, max_new_tokens=1500)
    wave = audio[0, 0].detach().cpu().numpy().astype(np.float32)
    sf.write(f"{out}/music-{i}.wav", wave, rate)
    print(f"music-{i}.wav {len(wave) / rate:.1f}s on {device}")
