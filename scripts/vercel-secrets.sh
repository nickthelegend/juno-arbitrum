#!/usr/bin/env bash
# Set the API's secrets on the Vercel project juno-arb-api from
# server/.env.local, then redeploy. Run this yourself: it moves database
# passwords, the Pinata JWT and the faucet key into Vercel.
#
#   bash scripts/vercel-secrets.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV="$ROOT/server/.env.local"
SCOPE="${VERCEL_SCOPE:-nicolas-projects-f497bb7f}"
cd "$ROOT"
for name in DATABASE_URL MONGODB_URI PINATA_JWT FAUCET_PRIVATE_KEY JUNO_INDEX_SECRET JUNO_SESSION_SECRET KEEPER_PRIVATE_KEY; do
  value=$(grep -E "^${name}=" "$ENV" | head -1 | cut -d= -f2-)
  [ -n "$value" ] || { echo "no $name in server/.env.local"; exit 1; }
  printf "%s" "$value" | vercel env add "$name" production --force --sensitive --scope "$SCOPE" >/dev/null
  echo "set $name (value not shown)"
done
bash "$ROOT/scripts/deploy-api.sh"
