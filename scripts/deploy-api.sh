#!/usr/bin/env bash
# Build the API (server/) locally with Vercel's builder and deploy it to the
# juno-arb-api project. server/.env.local is moved aside for the build, because
# Vercel's Next builder otherwise ships local env files inside the functions.
#
#   bash scripts/deploy-api.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCOPE="${VERCEL_SCOPE:-nicolas-projects-f497bb7f}"
cd "$ROOT"
HOLD="$(mktemp -d)"
[ -f server/.env.local ] && mv server/.env.local "$HOLD/"
trap '[ -f "$HOLD/.env.local" ] && mv "$HOLD/.env.local" server/.env.local' EXIT
rm -rf .vercel/output
vercel pull --yes --environment=production --scope "$SCOPE" >/dev/null
# The API lives in server/ but imports ../config, so it is built from the repo
# root with the Root Directory set to server/.
python3 - <<'PY'
import json
p = ".vercel/project.json"
d = json.load(open(p))
# installCommand: `vercel build` would otherwise reinstall from the lockfile
# and prune the linux binaries installed below.
d.setdefault("settings", {}).update({"rootDirectory": "server", "framework": "nextjs", "installCommand": "echo using the local node_modules"})
json.dump(d, open(p, "w"))
PY
# Vercel runs the functions on linux-arm64 and this build runs on macOS, so
# the native binaries the upload route needs (sharp, ffmpeg, ffprobe) are
# installed for linux-arm64 first. --no-save keeps package.json and the
# lockfile as they are; the chmod is the packages' own postinstall, which
# npm's script policy skips.
(cd server && npm install --no-save --force --no-audit --no-fund \
  @img/sharp-linux-arm64@0.35.5 @img/sharp-libvips-linux-arm64@1.3.4 \
  @ffmpeg-installer/linux-arm64@4.1.4 @ffprobe-installer/linux-arm64@5.2.0 >/dev/null 2>&1 &&
  chmod u+x node_modules/@ffmpeg-installer/linux-arm64/ffmpeg node_modules/@ffprobe-installer/linux-arm64/ffprobe)
[ -d server/node_modules/@img/sharp-linux-arm64 ] || { echo "linux-arm64 binaries missing"; exit 1; }
vercel build --prod
python3 - <<'PY'
import glob, json, sys
bad = [f for f in glob.glob(".vercel/output/functions/**/.vc-config.json", recursive=True)
       if any(k.startswith("server/.env") and not k.endswith(".example") for k in json.load(open(f)).get("filePathMap", {}))]
if bad:
    sys.exit(f"refusing to deploy: env files in {len(bad)} functions")
PY
vercel deploy --prebuilt --prod --archive=tgz --scope "$SCOPE"
curl -s https://juno-arb-api.vercel.app/api/health | head -c 400; echo
