#!/usr/bin/env bash
# Push the API's secrets from server/.env.local to the Railway service, then
# redeploy. Run this yourself: it moves database passwords, the Pinata JWT and
# the faucet key into Railway, which an agent should not do on its own.
#
#   bash scripts/railway-secrets.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV="$ROOT/server/.env.local"
[ -f "$ENV" ] || { echo "missing $ENV"; exit 1; }
cd "$ROOT"
args=()
for name in DATABASE_URL MONGODB_URI PINATA_JWT FAUCET_PRIVATE_KEY; do
  value=$(grep -E "^${name}=" "$ENV" | head -1 | cut -d= -f2-)
  [ -n "$value" ] || { echo "no $name in server/.env.local"; exit 1; }
  args+=(--set "${name}=${value}")
done
echo "Setting DATABASE_URL, MONGODB_URI, PINATA_JWT, FAUCET_PRIVATE_KEY on juno-arb-api (values not shown)."
railway variables --service juno-arb-api "${args[@]}" >/dev/null
echo "Done. Railway redeploys the service with them."
