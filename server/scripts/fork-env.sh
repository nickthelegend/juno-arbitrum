#!/bin/bash
# Source this to point the server at a local anvil fork of Arbitrum Sepolia,
# with its own Postgres and Mongo databases (`juno_arb_fork`) so fork data
# never mixes with the real chain's. Prints no secrets.
#   source scripts/fork-env.sh [rpc-url] [start-block]
set -a
. ./.env.local
set +a
export DATABASE_URL=$(node -e 'const u=new URL(process.env.DATABASE_URL);u.pathname="/juno_arb_fork";console.log(u.toString())')
export MONGODB_DB=juno_arb_fork
export ARB_SEPOLIA_RPC=${1:-http://127.0.0.1:8545}
export JUNO_LOCAL_ADDRESSES=1
if [ -n "$2" ]; then export JUNO_FACTORY_BLOCK_421614=$2; fi
echo "fork env: rpc=$ARB_SEPOLIA_RPC db=juno_arb_fork mongo=$MONGODB_DB start=${JUNO_FACTORY_BLOCK_421614:-auto}"
