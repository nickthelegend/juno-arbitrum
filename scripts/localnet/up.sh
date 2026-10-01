#!/usr/bin/env bash
# The whole of Juno on a local Arbitrum Nitro dev node (chain 412346, Stylus
# included): start the node, fund the project's deployer / faucet / keeper
# keys from the node's prefunded dev account, deploy WETH9 + Uniswap v3 from
# Uniswap's published artifacts, the Stylus CurveMath, and Juno (factory,
# TestUSDC, MockAggregators seeded from the real Arbitrum One feeds), then
# write every address into config/addresses.ts under 412346.
#
#   bash scripts/localnet/up.sh          # start (or restore after a reboot); deploys only if needed
#   bash scripts/localnet/up.sh --fresh  # a new chain and empty local databases
#
# The node runs in archive mode so every block's state is written to disk: in
# its default mode Nitro keeps recent state in memory and a hard stop (a
# reboot) rolled the chain back to its last flush while the databases kept
# the rows written after it.
set -euo pipefail
FRESH=0; [ "${1:-}" = "--fresh" ] && FRESH=1
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
set -a; source "$ROOT/.env"; set +a
export ARB_LOCAL_RPC="${ARB_LOCAL_RPC:-http://localhost:8747}"
RPC="$ARB_LOCAL_RPC"
PORT="${RPC##*:}"
# Nitro --dev's prefunded account: a published key that only exists on local dev chains.
DEV_KEY=0xb6b15c8cb491557369f3c7d2c287b053eb229daa9c22138887752191c9520659

# The three containers, published on 127.0.0.1 only: the node has the debug
# API on and funded public dev keys, Mongo has no auth, Postgres a toy password.
if [ "$FRESH" = 1 ]; then
  docker rm -f juno-nitro juno-pg juno-mongo >/dev/null 2>&1 || true
fi
if ! docker inspect juno-pg >/dev/null 2>&1; then
  docker run -d --name juno-pg -p 127.0.0.1:55442:5432 -e POSTGRES_USER=juno -e POSTGRES_PASSWORD=juno -e POSTGRES_DB=juno_local postgres:16 >/dev/null
  NEW_DB=1
fi
if ! docker inspect juno-mongo >/dev/null 2>&1; then
  docker run -d --name juno-mongo -p 127.0.0.1:27027:27017 mongo:7 >/dev/null
  NEW_DB=1
fi
docker start juno-pg juno-mongo >/dev/null
if [ "${NEW_DB:-0}" = 1 ]; then
  for _ in $(seq 1 30); do docker exec juno-pg pg_isready -U juno -d juno_local >/dev/null 2>&1 && break; sleep 1; done
  for _ in $(seq 1 30); do docker exec juno-mongo mongosh --quiet --eval 'db.runCommand({ping:1}).ok' >/dev/null 2>&1 && break; sleep 1; done
  # A new container answers inside itself a moment before its published port
  # does, so the first connection from here can time out: try a few times.
  for attempt in 1 2 3 4 5 6; do
    (cd "$ROOT/server" && npx tsx --env-file=.env.localnet scripts/migrate.ts >/dev/null && npx tsx --env-file=.env.localnet scripts/mongo-indexes.ts >/dev/null) && break
    [ "$attempt" = 6 ] && { echo "the local databases did not come up"; exit 1; }
    sleep 3
  done
  echo "local databases created (Postgres 127.0.0.1:55442, Mongo 127.0.0.1:27027)"
fi

chain_id() { curl -s -m 3 -X POST "$RPC" -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId"}' | grep -o '0x[0-9a-f]*' || true; }
docker start juno-nitro >/dev/null 2>&1 || true
for _ in $(seq 1 15); do [ "$(chain_id)" = "0x64aba" ] && break; sleep 2; done
if [ "$(chain_id)" != "0x64aba" ]; then
  docker rm -f juno-nitro >/dev/null 2>&1 || true
  docker run -d --name juno-nitro -p "127.0.0.1:$PORT:8547" offchainlabs/nitro-node:v3.7.1-926f1ab \
    --dev --http.addr 0.0.0.0 --http.api=net,web3,eth,debug --http.corsdomain='*' --http.vhosts='*' \
    --init.dev-max-code-size 49152 --execution.caching.archive >/dev/null
  for _ in $(seq 1 60); do [ "$(chain_id)" = "0x64aba" ] && break; sleep 2; done
fi
[ "$(chain_id)" = "0x64aba" ] || { echo "the Nitro dev node did not come up on $RPC"; exit 1; }
# A node killed hard (SIGKILL, power loss) can keep its blocks but not its
# sequencer position, and then refuses every transaction ("wrong msgIdx").
if ! out=$(cast send "$(cast wallet address "$DEV_KEY")" --value 0 --private-key "$DEV_KEY" --rpc-url "$RPC" 2>&1); then
  echo "the node refuses transactions: ${out##*error}"
  echo "its state is inconsistent after a hard stop; start over with: bash scripts/localnet/up.sh --fresh"
  exit 1
fi
echo "Nitro dev node on $RPC (chain 412346)"

for who in DEPLOYER FAUCET KEEPER; do
  addr_var="${who}_ADDRESS"; addr="${!addr_var}"
  bal=$(cast balance "$addr" --rpc-url "$RPC")
  if [ "$(echo "$bal < 50000000000000000000" | bc)" = 1 ]; then
    cast send "$addr" --value 100ether --private-key "$DEV_KEY" --rpc-url "$RPC" >/dev/null
  fi
  echo "  $who $addr: $(cast balance "$addr" --rpc-url "$RPC" --ether) ETH"
done

# Already deployed on this node (a restart, not a new chain): keep it. The
# address book's factory is the one the API and the web build point at.
BOOK_FACTORY=$(awk '/412346: \{/,/^  \},/' "$ROOT/config/addresses.ts" | grep -oE 'factory: "0x[0-9a-fA-F]{40}"' | grep -oE '0x[0-9a-fA-F]{40}' | head -1 || true)
if [ "$FRESH" = 0 ] && [ "${REDEPLOY:-0}" = 0 ] && [ -n "$BOOK_FACTORY" ] && [ "$(cast code "$BOOK_FACTORY" --rpc-url "$RPC")" != "0x" ]; then
  echo "Juno already on the local node: factory $BOOK_FACTORY (REDEPLOY=1 to deploy again)"
  exit 0
fi

# WETH9 + Uniswap v3
eval "$(cd "$ROOT/scripts" && npx tsx localnet/deploy-infra.ts)"
export LOCAL_WETH LOCAL_UNISWAP_FACTORY LOCAL_POSITION_MANAGER
echo "  WETH9 $LOCAL_WETH  UniswapV3Factory $LOCAL_UNISWAP_FACTORY  NonfungiblePositionManager $LOCAL_POSITION_MANAGER"

# Stylus CurveMath (deploy + activate)
cd "$ROOT/stylus/curve-math"
OUT=$(cargo stylus deploy --endpoint "$RPC" --private-key "$DEPLOYER_PRIVATE_KEY" --no-verify 2>&1)
CURVE_MATH=$(echo "$OUT" | sed 's/\x1b\[[0-9;]*m//g' | grep -oE "deployed code at address:? *0x[0-9a-fA-F]{40}" | grep -oE "0x[0-9a-fA-F]{40}" | head -1)
[ -n "$CURVE_MATH" ] || { echo "$OUT" | tail -20; echo "could not read the Stylus address"; exit 1; }
echo "  CurveMath (Stylus) $CURVE_MATH"

# Juno: factory, TestUSDC, feeds seeded from the real Arbitrum One prices
seed() { cast call "$1" "latestRoundData()(uint80,int256,uint256,uint256,uint80)" --rpc-url "$ARB_ONE_RPC" | sed -n 2p | awk '{print $1}'; }
export SEED_TSLA=$(seed 0x3609baAa0a9b1f0FE4d6CC01884585d0e191C3E3)
export SEED_NVDA=$(seed 0x4881A4418b5F2460B21d6F08CD5aA0678a7f262F)
export SEED_AAPL=$(seed 0x8d0CC5f38f9E802475f2CFf4F9fc7000C2E1557c)
cd "$ROOT/contracts"
# --skip-simulation: the node estimates gas, which includes ArbOS L1 costs forge cannot model.
LOG=$(CURVE_MATH="$CURVE_MATH" TREASURY="$DEPLOYER_ADDRESS" forge script script/Deploy.s.sol --rpc-url "$RPC" --broadcast --slow --skip-simulation 2>&1) || { echo "$LOG" | tail -30; exit 1; }
get() { echo "$LOG" | grep -E "^\s*$1 0x" | awk '{print $2}' | head -1; }
FACTORY=$(get FACTORY)
BLOCK=$(cast receipt "$(jq -r '.transactions[] | select(.contractName=="JunoFactory" and .transactionType=="CREATE") | .hash' broadcast/Deploy.s.sol/412346/run-latest.json)" blockNumber --rpc-url "$RPC")

# The keeper owns the mock feeds, as on Sepolia
for sym in TSLA NVDA AAPL; do
  cast send "$(get FEED_$sym)" "transferOwnership(address)" "$KEEPER_ADDRESS" --private-key "$DEPLOYER_PRIVATE_KEY" --rpc-url "$RPC" >/dev/null
done

# Multicall3 (the server batches reads through it): Arbitrum One's runtime
# code, deployed as-is behind a 10-byte copy-and-return constructor.
RT=$(cast code 0xcA11bde05977b3631167028862bE2a173976CA11 --rpc-url "$ARB_ONE_RPC")
INIT=$(printf "0x61%04x80600a3d393df3%s" $(( (${#RT} - 2) / 2 )) "${RT#0x}")
MULTICALL3=$(cast send --private-key "$DEPLOYER_PRIVATE_KEY" --rpc-url "$RPC" --json --create "$INIT" | jq -r .contractAddress)

cd "$ROOT/scripts"
npx tsx write-addresses.ts 412346 multicall3="$MULTICALL3"
npx tsx write-addresses.ts 412346 factory="$FACTORY" curveImpl="$(get CURVE_IMPL)" curveMath="$CURVE_MATH" usdc="$(get USDC)" \
  TSLA="$(get FEED_TSLA)" NVDA="$(get FEED_NVDA)" AAPL="$(get FEED_AAPL)" factoryBlock="$BLOCK" \
  weth="$LOCAL_WETH" uniswapV3Factory="$LOCAL_UNISWAP_FACTORY" positionManager="$LOCAL_POSITION_MANAGER"
echo "Juno on the local node: factory $FACTORY (block $BLOCK)"
