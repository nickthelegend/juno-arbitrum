"""
Cut the dead air out of a screen recording.

Driving the simulator leaves pauses between taps — waiting for a quote, for a
transaction to confirm, for the next command — and on screen they are just a
frozen frame. This finds every freeze with ffmpeg's `freezedetect` and keeps
only its first `--hold` seconds, so a result still lands on screen long
enough to read and nothing else waits.

    python3 scripts/demo/tighten.py in.mp4 out.mp4 [--hold 1.2] [--start 0] [--end 0]

`--start`/`--end` trim the clip first (seconds into the source; end 0 = to
the end). Works on any constant-frame-rate file, framed or raw.
"""
import re
import subprocess
import sys


def arg(name, default):
    if f"--{name}" in sys.argv:
        return float(sys.argv[sys.argv.index(f"--{name}") + 1])
    return default


def duration(path):
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path],
        capture_output=True, text=True, check=True,
    ).stdout
    return float(out.strip())


def freezes(path, start, end):
    """(from, to) of every frozen stretch of at least 0.8s, in source seconds."""
    cmd = ["ffmpeg", "-hide_banner", "-nostats", "-ss", str(start)]
    if end:
        cmd += ["-to", str(end)]
    cmd += ["-i", path, "-vf", "freezedetect=n=0.002:d=0.8", "-map", "0:v", "-f", "null", "-"]
    log = subprocess.run(cmd, capture_output=True, text=True).stderr
    starts = [float(x) for x in re.findall(r"freeze_start: ([\d.]+)", log)]
    ends = [float(x) for x in re.findall(r"freeze_end: ([\d.]+)", log)]
    total = (end or duration(path)) - start
    if len(ends) < len(starts):
        ends.append(total)
    return list(zip(starts, ends))


def main():
    src, dst = sys.argv[1], sys.argv[2]
    hold = arg("hold", 1.2)
    start = arg("start", 0.0)
    end = arg("end", 0.0)

    cuts = [(a + hold, b) for a, b in freezes(src, start, end) if b - a > hold]
    expr = "+".join(f"between(t,{a:.3f},{b:.3f})" for a, b in cuts) or "0"

    cmd = ["ffmpeg", "-loglevel", "error", "-y", "-ss", str(start)]
    if end:
        cmd += ["-to", str(end)]
    cmd += [
        "-i", src,
        "-vf", f"select='not({expr})',setpts=N/30/TB,fps=30,format=yuv420p",
        "-an", "-c:v", "libx264", "-crf", "18", "-preset", "medium", "-movflags", "+faststart", dst,
    ]
    subprocess.run(cmd, check=True)
    removed = sum(b - a for a, b in cuts)
    print(f"{dst}: {len(cuts)} pauses cut, {removed:.1f}s removed, {duration(dst):.1f}s left")


if __name__ == "__main__":
    main()
