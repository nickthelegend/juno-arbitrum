#!/usr/bin/env bash
# Deploy Juno to Arbitrum Sepolia (default) or Arbitrum One:
#   1. the Stylus CurveMath program (deployed + activated, then verified)
#   2. the factory and curve implementation (Foundry), verified on Arbiscan
#   3. Sepolia only: TestUSDC, three MockAggregators seeded from the real
#      Arbitrum One Chainlink feeds, and CurveMathRef for the differential test
#   4. config/addresses.ts + config/abi.ts updated
#
#   bash scripts/deploy.sh            # Arbitrum Sepolia
#   CHAIN=one bash scripts/deploy.sh  # Arbitrum One (asks before spending)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
set -a; source "$ROOT/.env"; set +a

if [ "${CHAIN:-sepolia}" = "one" ]; then CHAIN_ID=42161; RPC="$ARB_ONE_RPC"; NET=arbitrum; else CHAIN_ID=421614; RPC="$ARB_SEPOLIA_RPC"; NET=arbitrum_sepolia; fi
echo "Deploying to chain $CHAIN_ID from $DEPLOYER_ADDRESS"
BAL=$(cast balance "$DEPLOYER_ADDRESS" --rpc-url "$RPC" --ether)
echo "Deployer balance: $BAL ETH"
if [ "$CHAIN_ID" = "42161" ]; then
  read -r -p "This spends real ETH on Arbitrum One. Type yes to continue: " OK
  [ "$OK" = "yes" ] || { echo "aborted"; exit 1; }
fi

# 1. Stylus program
cd "$ROOT/stylus/curve-math"
OUT=$(cargo stylus deploy --endpoint "$RPC" --private-key "$DEPLOYER_PRIVATE_KEY" --no-verify --max-fee-per-gas-gwei "${MAX_FEE_GWEI:-0.06}" 2>&1 | tee /dev/stderr)
CURVE_MATH=$(echo "$OUT" | sed 's/\x1b\[[0-9;]*m//g' | grep -oE "deployed code at address:? *0x[0-9a-fA-F]{40}" | grep -oE "0x[0-9a-fA-F]{40}" | head -1)
[ -n "$CURVE_MATH" ] || { echo "could not read the Stylus address"; exit 1; }
echo "CurveMath (Stylus): $CURVE_MATH"

# 2 + 3. Solidity
seed() { cast call "$1" "latestRoundData()(uint80,int256,uint256,uint256,uint80)" --rpc-url "$ARB_ONE_RPC" | sed -n 2p | awk '{print $1}'; }
export SEED_TSLA=$(seed 0x3609baAa0a9b1f0FE4d6CC01884585d0e191C3E3)
export SEED_NVDA=$(seed 0x4881A4418b5F2460B21d6F08CD5aA0678a7f262F)
export SEED_AAPL=$(seed 0x8d0CC5f38f9E802475f2CFf4F9fc7000C2E1557c)
cd "$ROOT/contracts"
VERIFY=()
if [ -n "${ARBISCAN_API_KEY:-}" ]; then VERIFY=(--verify); fi
LOG=$(CURVE_MATH="$CURVE_MATH" forge script script/Deploy.s.sol --rpc-url "$NET" --broadcast --slow ${VERIFY[@]+"${VERIFY[@]}"} 2>&1 | tee /dev/stderr)
get() { echo "$LOG" | grep -E "^\s*$1 0x" | awk '{print $2}' | head -1; }
FACTORY=$(get FACTORY)
BLOCK=$(cast receipt "$(jq -r '.transactions[] | select(.contractName=="JunoFactory" and .transactionType=="CREATE") | .hash' broadcast/Deploy.s.sol/$CHAIN_ID/run-latest.json)" blockNumber --rpc-url "$RPC")
ARGS=(factory="$FACTORY" curveImpl="$(get CURVE_IMPL)" curveMath="$CURVE_MATH" factoryBlock="$BLOCK")
if [ "$CHAIN_ID" = "421614" ]; then
  ARGS+=(usdc="$(get USDC)" TSLA="$(get FEED_TSLA)" NVDA="$(get FEED_NVDA)" AAPL="$(get FEED_AAPL)")
  REF="$(get CURVE_MATH_REF)"; [ -n "$REF" ] && ARGS+=(curveMathRef="$REF")
fi

# 4. Address book and ABI
cd "$ROOT/scripts"
npx tsx write-addresses.ts "$CHAIN_ID" "${ARGS[@]}"
node "$ROOT/scripts/gen-abi.mjs"

# Stylus source verification (reproducible build in Docker)
if [ -n "${SKIP_STYLUS_VERIFY:-}" ]; then echo "skipping cargo stylus verify"; else
  DEPLOY_TX=$(echo "$OUT" | sed 's/\x1b\[[0-9;]*m//g' | grep -oiE "deployment tx hash:? *0x[0-9a-f]{64}" | grep -oE "0x[0-9a-f]{64}" | head -1)
  if [ -n "$DEPLOY_TX" ]; then (cd "$ROOT/stylus/curve-math" && cargo stylus verify --endpoint "$RPC" --deployment-tx "$DEPLOY_TX") || echo "stylus verify failed (non-fatal)"; fi
fi
echo "Done. Factory $FACTORY at block $BLOCK"
