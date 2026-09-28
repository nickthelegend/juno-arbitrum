/**
 * Differential test: the deployed Stylus CurveMath against the Solidity
 * reference CurveMathRef, over random inputs, through eth_call. Every result
 * must match to the wei. Exits non-zero on the first mismatch.
 *
 *   tsx diff-curve-math.ts [runs=300]
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { curveMathAbi } from "../config/abi";
import { clients } from "./lib";

const runs = Number(process.argv[2] ?? 300);
const { publicClient, addresses } = clients(421614);
if (!addresses.curveMath) throw new Error("deploy CurveMath first");
const stylus = addresses.curveMath;
// The Solidity reference is injected into each eth_call with a state
// override (its runtime bytecode at a scratch address), so it never has to be
// deployed. If a deployed copy is recorded, that is used instead.
const artifact = JSON.parse(readFileSync(fileURLToPath(new URL("../contracts/out/CurveMathRef.sol/CurveMathRef.json", import.meta.url)), "utf8"));
const ref = (addresses.curveMathRef ?? "0x00000000000000000000000000000000000c0ffe") as `0x${string}`;
const overrideFor = (address: `0x${string}`) =>
  address === ref && !addresses.curveMathRef ? [{ address: ref, code: artifact.deployedBytecode.object as `0x${string}` }] : undefined;

const rand = (n: bigint) => BigInt(Math.floor(Math.random() * 2 ** 52)) % n;
const E18 = 10n ** 18n;

async function both(fn: string, args: unknown[]) {
  const call = (address: `0x${string}`) =>
    publicClient
      .readContract({ address, abi: curveMathAbi, functionName: fn as never, args: args as never, stateOverride: overrideFor(address) } as never)
      .then((v) => ({ ok: true as const, v }))
      .catch((e) => ({ ok: false as const, v: e.shortMessage as string }));
  const [a, b] = await Promise.all([call(stylus), call(ref)]);
  const same = a.ok === b.ok && (a.ok ? JSON.stringify(a.v, (_, x) => (typeof x === "bigint" ? x.toString() : x)) === JSON.stringify(b.v, (_, x) => (typeof x === "bigint" ? x.toString() : x)) : true);
  if (!same) {
    console.error("MISMATCH", fn, args, { stylus: a, ref: b });
    process.exit(1);
  }
  return a;
}

let checked = 0;
for (let i = 0; i < runs; i++) {
  const preset = Number(rand(4n));
  const supply = preset === 3 ? (100n + rand(1_000_000n)) * E18 : 200_000_000n * E18 + rand(10n ** 26n);
  const p0 = 1n + rand(10n ** 12n);
  const cap = preset === 3 ? E18 + 1n + rand(2n * E18) : 2n * E18 + rand(98n * E18);
  const sold = rand(supply + 1n);
  const amount = rand(supply - sold + 1n);
  await both("priceAt", [preset, p0, cap, supply, sold]);
  const cost = await both("costToBuy", [preset, p0, cap, supply, sold, amount]);
  if (cost.ok) await both("amountForCost", [preset, p0, cap, supply, sold, cost.v as bigint]);
  await both("amountForCost", [preset, p0, cap, supply, sold, rand(10n ** 24n)]);
  await both("proceedsToSell", [preset, p0, cap, supply, sold, rand(sold + 1n)]);
  await both("feeBps", [BigInt(100 + Number(rand(900n))), BigInt(Number(rand(100n))), 600n, rand(700n)]);
  if (i % 50 === 0) await both("boundaries", [preset, p0, cap, supply]);
  checked += 6;
}
console.log(`Stylus CurveMath == CurveMathRef on ${checked} calls (${runs} random curves)`);
