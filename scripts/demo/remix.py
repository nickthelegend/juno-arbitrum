"""
Re-mix the film's soundtrack without re-rendering the picture.

    python3 scripts/demo/remix.py .juno/video/final/hf film.mp4 out.mp4

Reads every <audio> in the composition (source, start, duration, volume,
fades), mixes them the way HyperFrames does, normalises to -16 LUFS, and puts
the result under the existing video stream, copied as-is. A music change
takes a minute instead of a full render.
"""
import re
import subprocess
import sys

HF, FILM, OUT = sys.argv[1:4]
film_length = subprocess.run(
    ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", FILM],
    capture_output=True, text=True, check=True,
).stdout.strip()
html = open(f"{HF}/index.html").read()

tracks = []
for tag in re.findall(r"<audio\b[^>]*>", html):
    attr = dict(re.findall(r'([\w-]+)="([^"]*)"', tag))
    tracks.append(
        {
            "src": f"{HF}/{attr['src']}",
            "start": float(attr["data-start"]),
            "dur": float(attr["data-duration"]),
            "vol": float(attr.get("data-volume", 1)),
            "fin": float(attr.get("data-fade-in", 0)),
            "fout": float(attr.get("data-fade-out", 0)),
        }
    )

inputs, chains = [], []
for i, t in enumerate(tracks):
    inputs += ["-i", t["src"]]
    chain = f"[{i + 1}:a]aformat=sample_rates=48000:channel_layouts=stereo,atrim=0:{t['dur']:.3f},asetpts=PTS-STARTPTS"
    if t["fin"]:
        chain += f",afade=t=in:st=0:d={t['fin']}"
    if t["fout"]:
        chain += f",afade=t=out:st={max(t['dur'] - t['fout'], 0):.3f}:d={t['fout']}"
    delay = int(round(t["start"] * 1000))
    chain += f",volume={t['vol']},adelay={delay}|{delay}[a{i}]"
    chains.append(chain)

mix = "".join(f"[a{i}]" for i in range(len(tracks)))
graph = ";".join(chains) + f";{mix}amix=inputs={len(tracks)}:normalize=0:dropout_transition=0:duration=longest,loudnorm=I=-16:TP=-1.5:LRA=11,apad[out]"

subprocess.run(
    ["ffmpeg", "-loglevel", "error", "-y", "-i", FILM, *inputs, "-filter_complex", graph,
     "-map", "0:v", "-map", "[out]", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
     "-t", film_length, "-movflags", "+faststart", OUT],
    check=True,
)
print(OUT, len(tracks), "tracks")
