#!/usr/bin/env bash
# The whole of Juno on a local Arbitrum Nitro dev node (chain 412346, Stylus
# included): start the node, fund the project's deployer / faucet / keeper
# keys from the node's prefunded dev account, deploy WETH9 + Uniswap v3 from
# Uniswap's published artifacts, the Stylus CurveMath, and Juno (factory,
# TestUSDC, MockAggregators seeded from the real Arbitrum One feeds), then
# write every address into config/addresses.ts under 412346.
#
#   bash scripts/localnet/up.sh          # idempotent: re-running redeploys Juno
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
set -a; source "$ROOT/.env"; set +a
export ARB_LOCAL_RPC="${ARB_LOCAL_RPC:-http://localhost:8747}"
RPC="$ARB_LOCAL_RPC"
PORT="${RPC##*:}"
# Nitro --dev's prefunded account: a published key that only exists on local dev chains.
DEV_KEY=0xb6b15c8cb491557369f3c7d2c287b053eb229daa9c22138887752191c9520659

chain_id() { curl -s -m 3 -X POST "$RPC" -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId"}' | grep -o '0x[0-9a-f]*' || true; }
if [ "$(chain_id)" != "0x64aba" ]; then
  docker rm -f juno-nitro >/dev/null 2>&1 || true
  docker run -d --name juno-nitro -p "$PORT:8547" offchainlabs/nitro-node:v3.7.1-926f1ab \
    --dev --http.addr 0.0.0.0 --http.api=net,web3,eth,debug --http.corsdomain='*' --http.vhosts='*' \
    --init.dev-max-code-size 49152 >/dev/null
  for _ in $(seq 1 60); do [ "$(chain_id)" = "0x64aba" ] && break; sleep 2; done
fi
[ "$(chain_id)" = "0x64aba" ] || { echo "the Nitro dev node did not come up on $RPC"; exit 1; }
echo "Nitro dev node on $RPC (chain 412346)"

for who in DEPLOYER FAUCET KEEPER; do
  addr_var="${who}_ADDRESS"; addr="${!addr_var}"
  bal=$(cast balance "$addr" --rpc-url "$RPC")
  if [ "$(echo "$bal < 50000000000000000000" | bc)" = 1 ]; then
    cast send "$addr" --value 100ether --private-key "$DEV_KEY" --rpc-url "$RPC" >/dev/null
  fi
  echo "  $who $addr: $(cast balance "$addr" --rpc-url "$RPC" --ether) ETH"
done

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
