#!/usr/bin/env bash
# A clean local demo: a new chain and empty databases, the API (restarted on
# the new databases), the three stock trackers, then the demo seed: five named
# creators, six posts and reels, ~30 trades with notes, a graduation into
# Uniswap v3, comments, likes, follows, and every reel and poster warmed.
#
#   bash scripts/localnet/demo.sh       # then open http://localhost:8091
#
# The web build it serves is app/dist-local (see the README's local section).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
LOG="${TMPDIR:-/tmp}/juno-local-api.log"

pkill -f "next dev --port 3111" 2>/dev/null || true
bash "$ROOT/scripts/localnet/up.sh" --fresh

# The API reads the new databases; start it again and wait for it.
(cd "$ROOT/server" && set -a && . ./.env.localnet && set +a && nohup npx next dev --port 3111 >"$LOG" 2>&1 &)
for _ in $(seq 1 90); do
  [ "$(curl -s -o /dev/null -w '%{http_code}' http://localhost:3111/api/health)" = 200 ] && break
  sleep 2
done
[ "$(curl -s -o /dev/null -w '%{http_code}' http://localhost:3111/api/health)" = 200 ] || { echo "the local API did not start (see $LOG)"; exit 1; }
echo "local API on http://localhost:3111 (log: $LOG)"

(cd "$ROOT/scripts" && npx tsx localnet/trackers.ts)

# The seed's progress is per chain and factory, and a fresh chain reuses the
# factory address: start it over.
rm -f "$ROOT"/.juno/demo-arb/progress-412346-*.json
(cd "$ROOT/server" && npx tsx --env-file=.env.localnet --env-file=../.env --conditions=react-server \
  scripts/demo-activity.ts --chain 412346 --api http://localhost:3111 --fund 0.2)

if [ "$(curl -s -o /dev/null -w '%{http_code}' http://localhost:8091/)" != 200 ]; then
  (cd "$ROOT/app" && nohup npx --yes serve@14 -s dist-local -l 8091 >/dev/null 2>&1 &)
fi
echo "demo ready: http://localhost:8091"
