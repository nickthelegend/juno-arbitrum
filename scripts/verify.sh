#!/usr/bin/env bash
# Verify every Juno contract of a deployment on Sourcify and Blockscout (no key
# needed), and on Arbiscan when ARBISCAN_API_KEY is set in .env. Idempotent:
# already-verified contracts are reported and skipped by the verifiers.
#
#   bash scripts/verify.sh            # Arbitrum Sepolia
#   CHAIN=one bash scripts/verify.sh  # Arbitrum One
#
# Covers the factory, the curve implementation, every launched token (read
# from the factory's Launched events), and on Sepolia the test USDC and mock
# feeds. Curves are EIP-1167 clones of the verified implementation, which the
# explorers resolve on their own.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
set -a; source "$ROOT/.env"; set +a
if [ "${CHAIN:-sepolia}" = "one" ]; then CHAIN_ID=42161; RPC="$ARB_ONE_RPC"; BS=https://arbitrum.blockscout.com; else CHAIN_ID=421614; RPC="$ARB_SEPOLIA_RPC"; BS=https://arbitrum-sepolia.blockscout.com; fi

addr() { # read a field of this chain's entry in config/addresses.ts
  node -e "
    const s=require('fs').readFileSync('$ROOT/config/addresses.ts','utf8');
    const i=s.indexOf('  $CHAIN_ID: {'); const e=s.indexOf('\n  },',i);
    const m=s.slice(i,e).match(new RegExp('\\\\b$1: \"?(0x[0-9a-fA-F]{40}|\\\\d+)'));
    process.stdout.write(m?m[1]:'')"
}

verify() { # address path:Name [abi-encoded constructor args | guess]
  local a=$1 c=$2 args=${3:-} out
  local common=(--chain "$CHAIN_ID" --rpc-url "$RPC" --watch)
  if [ "$args" = guess ]; then common+=(--guess-constructor-args); elif [ -n "$args" ]; then common+=(--constructor-args "$args"); fi
  out=$(cd "$ROOT/contracts" && forge verify-contract "$a" "$c" "${common[@]}" --verifier sourcify 2>&1 | grep -E "verified|match|already|Error" | tail -1)
  echo "  sourcify   ${c##*:} $a: $(printf %s "${out:-no output}" | cut -c1-140)"
  out=$(cd "$ROOT/contracts" && forge verify-contract "$a" "$c" "${common[@]}" --verifier blockscout --verifier-url "$BS/api/" 2>&1 | grep -E "verified|Verified|already|Error" | tail -1)
  echo "  blockscout ${c##*:} $a: $(printf %s "${out:-no output}" | cut -c1-140)"
  if [ -n "${ARBISCAN_API_KEY:-}" ]; then
    out=$(cd "$ROOT/contracts" && forge verify-contract "$a" "$c" "${common[@]}" --verifier etherscan --etherscan-api-key "$ARBISCAN_API_KEY" 2>&1 | grep -E "verified|Verified|already|Error" | tail -1)
    echo "  arbiscan   ${c##*:} $a: $(printf %s "${out:-no output}" | cut -c1-140)"
  fi
}

FACTORY=$(addr factory)
[ -n "$FACTORY" ] || { echo "no factory recorded for chain $CHAIN_ID"; exit 1; }
echo "Chain $CHAIN_ID, factory $FACTORY"
TREASURY=$(cast call "$FACTORY" "treasury()(address)" --rpc-url "$RPC")
CURVE_MATH=$(addr curveMath)
verify "$FACTORY" src/JunoFactory.sol:JunoFactory guess
verify "$(addr curveImpl)" src/JunoCurve.sol:JunoCurve

if [ "$CHAIN_ID" = 421614 ]; then
  verify "$(addr usdc)" src/test-helpers/TestUSDC.sol:TestUSDC
  for sym in TSLA NVDA AAPL; do
    feed=$(addr "$sym")
    desc=$(cast call "$feed" "description()(string)" --rpc-url "$RPC")
    dec=$(cast call "$feed" "decimals()(uint8)" --rpc-url "$RPC")
    seed=$(cd "$ROOT/contracts" && jq -r --arg a "$(echo "$feed" | tr A-F a-f)" '.transactions[] | select((.contractAddress|ascii_downcase)==$a) | .arguments | @tsv' "broadcast/Deploy.s.sol/$CHAIN_ID/run-latest.json")
    answer=$(echo "$seed" | cut -f3); updated=$(echo "$seed" | cut -f4)
    verify "$feed" src/test-helpers/MockAggregator.sol:MockAggregator "$(cast abi-encode 'c(string,uint8,int256,uint256)' "$desc" "$dec" "$answer" "$updated")"
  done
fi

# Every launched token: constructor args read back from the chain.
FROM=$(addr factoryBlock)
TOPIC=$(cast keccak "Launched(address,address,address,uint8,address,address,uint16,uint256,uint256,uint256,uint256,address,string)")
for t in $(cast logs --from-block "$FROM" --address "$FACTORY" "$TOPIC" --rpc-url "$RPC" --json 2>/dev/null | jq -r '.[].topics[2] // empty' | sed 's/^0x000000000000000000000000/0x/' | sort -u); do
  name=$(cast call "$t" "name()(string)" --rpc-url "$RPC" | sed 's/^"//;s/"$//')
  sym=$(cast call "$t" "symbol()(string)" --rpc-url "$RPC" | sed 's/^"//;s/"$//')
  uri=$(cast call "$t" "metadataURI()(string)" --rpc-url "$RPC" | sed 's/^"//;s/"$//')
  supply=$(cast call "$t" "totalSupply()(uint256)" --rpc-url "$RPC" | awk '{print $1}')
  curve=$(cast call "$t" "curve()(address)" --rpc-url "$RPC")
  verify "$t" src/JunoToken.sol:JunoToken "$(cast abi-encode 'c(string,string,string,uint256,address)' "$name" "$sym" "$uri" "$supply" "$curve")"
done
echo "Treasury $TREASURY; Stylus CurveMath $CURVE_MATH (verify with cargo stylus verify)."
