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
d.setdefault("settings", {}).update({"rootDirectory": "server", "framework": "nextjs"})
json.dump(d, open(p, "w"))
PY
vercel build --prod
python3 - <<'PY'
import glob, json, sys
bad = [f for f in glob.glob(".vercel/output/functions/**/.vc-config.json", recursive=True)
       if any(k.startswith("server/.env") and not k.endswith(".example") for k in json.load(open(f)).get("filePathMap", {}))]
if bad:
    sys.exit(f"refusing to deploy: env files in {len(bad)} functions")
PY
vercel deploy --prebuilt --prod --scope "$SCOPE"
curl -s https://juno-arb-api.vercel.app/api/health | head -c 400; echo
