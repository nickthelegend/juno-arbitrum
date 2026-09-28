#!/usr/bin/env bash
# Put a simulator recording inside an iPhone 17 Pro body.
#
#   bash scripts/demo/frame-video.sh .juno/video/raw/01-feed.mp4
#
# Writes next to the input:
#   01-feed.framed.mov   ProRes 4444 with alpha: the phone on transparency,
#                        for HyperFrames or any editor to place over anything
#   01-feed.preview.mp4  1080x1920 H.264, the phone on Juno's sage background
set -euo pipefail
IN="$1"
DIR="$(cd "$(dirname "$0")/../.." && pwd)"
FRAME="$DIR/.juno/video/frame.png"
SHADOW="$DIR/.juno/video/frame-shadow.png"
[ -f "$FRAME" ] || python3 "$DIR/scripts/demo/device_frame.py" "$FRAME" >/dev/null

BASE="${IN%.*}"
# The frame is 1414x2830 with the screen cut-out at (104,104), 1206x2622.
ffmpeg -loglevel error -y -i "$IN" -loop 1 -i "$FRAME" -filter_complex "
  color=c=black@0:s=1414x2830:r=30,format=rgba[bg];
  [0:v]scale=1206:2622,fps=30[screen];
  [bg][screen]overlay=104:104:shortest=1[v1];
  [v1][1:v]overlay=0:0:shortest=1,format=yuva444p10le[out]" \
  -map "[out]" -c:v prores_ks -profile:v 4444 -pix_fmt yuva444p10le -an "$BASE.framed.mov"

ffmpeg -loglevel error -y -i "$BASE.framed.mov" -loop 1 -i "$SHADOW" -filter_complex "
  color=c=0xDCE7D5:s=1080x1920:r=30[bg];
  [1:v]scale=-2:1800[sh];
  [0:v]scale=-2:1800[phone];
  [bg][sh]overlay=(W-w)/2:(H-h)/2+22:shortest=1[b1];
  [b1][phone]overlay=(W-w)/2:(H-h)/2:shortest=1,format=yuv420p[out]" \
  -map "[out]" -c:v libx264 -crf 18 -preset medium -movflags +faststart "$BASE.preview.mp4"

echo "$BASE.framed.mov"
echo "$BASE.preview.mp4"
