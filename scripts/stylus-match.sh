#!/usr/bin/env bash
# Prove the deployed Stylus CurveMath was built from this source: rebuild the
# initcode with the pinned toolchain (stylus/curve-math/rust-toolchain.toml +
# Cargo.lock) and compare it byte for byte with the deployment transaction's
# input. Exits non-zero on any difference.
#
#   bash scripts/stylus-match.sh [deployment-tx] [rpc]
#
# The Sepolia program was deployed from a native build (`cargo stylus deploy
# --no-verify`), so `cargo stylus verify`, which rebuilds inside Docker, does
# not apply to it; this native comparison does. The build is reproducible per
# platform (macOS arm64 here; a Linux build lays the code out differently) and
# embeds dependency source paths, so rebuild on macOS arm64 with CARGO_HOME at
# /Users/jaibajrang/.cargo. CI (.github/workflows/stylus-verify.yml) does that.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TX="${1:-0x62ccef112150c59e5df0de6a7d987f4a81f4228279e5847ebf20138441f6ef3b}"
RPC="${2:-https://sepolia-rollup.arbitrum.io/rpc}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

cd "$ROOT/stylus/curve-math"
cargo stylus get-initcode --output "$WORK/local.hex" >/dev/null 2>&1
curl -fsS "$RPC" -H 'content-type: application/json' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_getTransactionByHash\",\"params\":[\"$TX\"]}" \
  | python3 -c 'import json,sys; t=json.load(sys.stdin)["result"]; assert t["to"] is None, "not a contract creation"; print(t["input"])' > "$WORK/chain.hex"

local=$(tr -d '\n' < "$WORK/local.hex" | sed 's/^0x//')
chain=$(tr -d '\n' < "$WORK/chain.hex" | sed 's/^0x//')
if [ "$local" = "$chain" ]; then
  echo "MATCH: deployment $TX == local build ($(( ${#local} / 2 )) bytes of initcode)"
else
  echo "MISMATCH: local ${#local} hex chars, on-chain ${#chain}" >&2
  exit 1
fi
