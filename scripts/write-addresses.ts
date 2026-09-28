/**
 * Write deployed addresses into config/addresses.ts.
 *
 *   tsx write-addresses.ts 421614 factory=0x.. curveImpl=0x.. curveMath=0x.. usdc=0x.. TSLA=0x.. NVDA=0x.. AAPL=0x..
 *
 * Keys factory/curveImpl/curveMath/usdc set those fields; TSLA/NVDA/AAPL set
 * feeds (Sepolia mocks); curveMathRef/factoryBlock are recorded too.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const file = fileURLToPath(new URL("../config/addresses.ts", import.meta.url));
const [chainArg, ...pairs] = process.argv.slice(2);
const chainId = Number(chainArg);
let src = readFileSync(file, "utf8");

const start = src.indexOf(`  ${chainId}: {`);
if (start < 0) throw new Error(`chain ${chainId} not in addresses.ts`);
const end = src.indexOf("\n  },", start);
let block = src.slice(start, end);

for (const pair of pairs) {
  const [key, value] = pair.split("=");
  if (!/^0x[0-9a-fA-F]{40}$/.test(value) && !/^\d+$/.test(value)) throw new Error(`bad value for ${key}`);
  const literal = /^\d+$/.test(value) ? value : `"${value}"`;
  if (["TSLA", "NVDA", "AAPL"].includes(key)) {
    if (/feeds: \{\}/.test(block)) block = block.replace("feeds: {}", "feeds: {\n    }");
    const re = new RegExp(`\\n      ${key}: "0x[0-9a-fA-F]{40}",`);
    if (re.test(block)) block = block.replace(re, `\n      ${key}: ${literal},`);
    else block = block.replace(/feeds: \{/, `feeds: {\n      ${key}: ${literal},`);
  } else {
    const re = new RegExp(`(\\n    ${key}: )[^,]+,`);
    if (re.test(block)) block = block.replace(re, `$1${literal},`);
    else block = block.replace(/\n    name:/, `\n    ${key}: ${literal},\n    name:`);
  }
}
src = src.slice(0, start) + block + src.slice(end);
writeFileSync(file, src);
console.log(`config/addresses.ts updated for ${chainId}: ${pairs.map((p) => p.split("=")[0]).join(", ")}`);
