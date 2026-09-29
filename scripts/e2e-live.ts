/**
 * Live end-to-end checks that need a key (docs/TEST-PLAN.md C3, C9, C10, D1).
 * Everything goes through the deployed API the app uses: the server builds,
 * this key signs and sends, the API records, and the result is read back.
 * Spends a few hundred-thousandths of Arbitrum Sepolia ETH.
 *
 *   npx tsx e2e-live.ts
 */
import { decodeFunctionData, erc20Abi, parseAbi, parseUnits, type Hex } from "viem";

import { junoCurveAbi } from "../config/abi";
import { clients, explorerTx } from "./lib";

const API = process.env.JUNO_API ?? "https://juno-arb-api.vercel.app";
const CHAIN = 421614;
const SMOKE = { token: "0x69f33cfa02073a1387dd25d0b45b25723acd82ce", curve: "0x7d4ceaa4e80aaa231f7b48d1cf8a7e84e340557b" };
const TSLA_CURVE = "0x079fcf8ebd2542884d0dda3d75e410e97ba71d3c";

const { publicClient, walletClient: deployer, account, addresses } = clients(CHAIN);
const keeper = clients(CHAIN, "KEEPER_PRIVATE_KEY");

type Step = { label: string; to: Hex; data: Hex; value: string; gas: string };

async function api<T>(method: string, path: string, body?: unknown, token?: string): Promise<{ status: number; body: T }> {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json().catch(() => null)) as T };
}

function check(label: string, ok: boolean, detail: unknown) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}  ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
  if (!ok) process.exitCode = 1;
}

async function send(wallet: typeof deployer, steps: Step[]): Promise<Hex> {
  let hash: Hex = "0x";
  for (const step of steps) {
    hash = await wallet.sendTransaction({ account: wallet.account!, chain: wallet.chain, to: step.to, data: step.data, value: BigInt(step.value), gas: BigInt(step.gas) });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`${step.label} reverted: ${hash}`);
  }
  return hash;
}

async function activity(): Promise<Array<{ txHash: string; side: string; amount: number }>> {
  const { body } = await api<{ activity: Array<{ txHash: string; side: string; amount: number }> }>("GET", `/api/juno/coins/${SMOKE.token}`);
  return body.activity;
}

// ---- C3: a wallet holding USDC with no allowance gets approve + buyWithQuote
{
  const hash = await keeper.walletClient.writeContract({ address: addresses.usdc!, abi: parseAbi(["function mint(address,uint256)"]), functionName: "mint", args: [keeper.account.address, parseUnits("10", 6)] });
  await publicClient.waitForTransactionReceipt({ hash });
  const allowance = await publicClient.readContract({ address: addresses.usdc!, abi: erc20Abi, functionName: "allowance", args: [keeper.account.address, TSLA_CURVE] });
  const built = await api<{ steps: Step[]; error?: string }>("POST", "/api/juno/tx/swap", { chainId: CHAIN, curve: TSLA_CURVE, trader: keeper.account.address, side: "buy", amountIn: "10" });
  const labels = built.body.steps?.map((s) => s.label);
  const approve = built.body.steps?.[0] && decodeFunctionData({ abi: erc20Abi, data: built.body.steps[0].data });
  const buy = built.body.steps?.[1] && decodeFunctionData({ abi: junoCurveAbi, data: built.body.steps[1].data });
  check("C3 approve then buyWithQuote when allowance is short", allowance === 0n && labels?.join(",") === "Approve USDC,Buy" && approve?.functionName === "approve" && String(approve.args[1]) === "10000000" && buy?.functionName === "buyWithQuote", { allowance: String(allowance), labels, error: built.body.error, mint: explorerTx(CHAIN, hash) });
}

// ---- C9: a real buy, built by the API, signed here, recorded, read back
{
  const before = await activity();
  const built = await api<{ steps: Step[]; quote: { amountOut: number } }>("POST", "/api/juno/tx/swap", { chainId: CHAIN, curve: SMOKE.curve, trader: account.address, side: "buy", amountIn: "0.000005" });
  const hash = await send(deployer, built.body.steps);
  const recorded = await api<{ trades: number }>("POST", "/api/juno/tx/record", { chainId: CHAIN, txHash: hash });
  const after = await activity();
  const row = after.find((a) => a.txHash === hash);
  check("C9 real buy on Sepolia: confirmed, recorded, in the coin's activity", recorded.body.trades === 1 && !!row && row.side === "buy" && after.length === before.length + 1, { tx: explorerTx(CHAIN, hash), amount: row?.amount, quoted: built.body.quote.amountOut });
}

// ---- C10: a real sell of part of it
{
  const built = await api<{ steps: Step[] }>("POST", "/api/juno/tx/swap", { chainId: CHAIN, curve: SMOKE.curve, trader: account.address, side: "sell", amountIn: "100000" });
  const hash = await send(deployer, built.body.steps);
  const recorded = await api<{ trades: number }>("POST", "/api/juno/tx/record", { chainId: CHAIN, txHash: hash });
  const row = (await activity()).find((a) => a.txHash === hash);
  check("C10 real sell on Sepolia: confirmed, recorded, in the coin's activity", recorded.body.trades === 1 && row?.side === "sell" && Math.abs(row.amount - 100000) < 1e-6, { tx: explorerTx(CHAIN, hash) });
}

// ---- D1 (for the UI check) + cleanup: the deployer claims a name and takes back
// the like an unauthenticated probe planted in its name before sessions existed.
{
  const wallet = account.address.toLowerCase();
  const issuedAt = new Date().toISOString();
  const session = await api<{ token: string }>("POST", "/api/juno/session", {
    chainId: CHAIN,
    wallet,
    issuedAt,
    signature: await account.signMessage({ message: `Juno session\nWallet: ${wallet}\nIssued: ${issuedAt}` }),
  });
  const unlike = await api<{ likes: number; liked: boolean }>("POST", "/api/juno/likes", { chainId: CHAIN, coin: SMOKE.token, wallet, like: false }, session.body.token);
  check("cleanup: the deployer's planted like removed with its own session", unlike.status === 200 && unlike.body.liked === false, unlike.body);
  const name = "juno_team";
  const nameIssued = new Date().toISOString();
  const claim = await api<{ name: string }>("POST", "/api/juno/profiles", {
    chainId: CHAIN,
    wallet,
    name,
    issuedAt: nameIssued,
    signature: await account.signMessage({ message: `Juno name: ${name}\nWallet: ${wallet}\nIssued: ${nameIssued}` }),
  });
  const names = await api<{ names: Record<string, string> }>("GET", `/api/juno/profiles?wallets=${wallet}`);
  check("D1 the deployer's name claim persists", claim.status === 200 && names.body.names[wallet] === name, { claim: claim.body, names: names.body.names });
}

