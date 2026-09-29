// Stamp a local mock feed stale (same answer, updatedAt = now - hours). Local node only.
import { readFileSync } from "node:fs";
import { createPublicClient, createWalletClient, defineChain, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
const RPC = process.env.ARB_LOCAL_RPC ?? "http://localhost:8747";
const env = Object.fromEntries(readFileSync(new URL("../../.env", import.meta.url), "utf8").split("\n").filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]));
const key = env.KEEPER_PRIVATE_KEY.startsWith("0x") ? env.KEEPER_PRIVATE_KEY : `0x${env.KEEPER_PRIVATE_KEY}`;
const chain = defineChain({ id: 412346, name: "Arbitrum Local", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const pub = createPublicClient({ chain, transport: http(RPC) });
const wallet = createWalletClient({ account: privateKeyToAccount(key), chain, transport: http(RPC) });
const abi = [
  { type: "function", name: "setAnswer", stateMutability: "nonpayable", inputs: [{ type: "int256" }, { type: "uint256" }], outputs: [] },
  { type: "function", name: "latestRoundData", stateMutability: "view", inputs: [], outputs: [{ type: "uint80" }, { type: "int256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint80" }] },
];
const [feed, hours = "0"] = process.argv.slice(2);
const [, answer] = await pub.readContract({ address: feed, abi, functionName: "latestRoundData" });
const at = BigInt(Math.floor(Date.now() / 1000) - Math.round(Number(hours) * 3600));
const hash = await wallet.writeContract({ address: feed, abi, functionName: "setAnswer", args: [answer, at] });
await pub.waitForTransactionReceipt({ hash });
console.log(`${feed} answer ${answer} updatedAt ${at} (${hours}h ago)`);
