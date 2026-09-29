import "server-only";

import { createWalletClient, fallback, http, type Hex, type Log } from "viem";

import { junoCurveAbi } from "@config/abi";
import { CallerError } from "./api";
import { isTestnet, publicClient, requireDeployment, rpcUrls, viemChain, type ChainId } from "./chains";
import { faucetAccount } from "./faucet";
import { recordLogs } from "./indexer";
import { invalidateCurve, readCurveState } from "./onchain";
import { knownCurves, type CurveRow } from "./registry";

/**
 * `tx/record`: write down what a transaction the device just sent did,
 * straight from its receipt, so the feed shows it before the next index pass.
 *
 * Only logs from this chain's factory and from curves Juno knows are
 * accepted (`events.ts`), so posting someone else's transaction hash records
 * nothing it should not.
 */

export type RecordResult = {
  ok: boolean;
  chainId: ChainId;
  txHash: string;
  status: "success" | "reverted";
  blockNumber: number | null;
  launched?: { token: string; curve: string };
  trades: number;
  claims: number;
  graduations: number;
  /** A curve this transaction filled was graduated by the server right after. */
  autoGraduated?: { curve: string; txHash: string } | null;
};

export async function recordTransaction(chainId: ChainId, txHash: Hex): Promise<RecordResult> {
  const { factory } = requireDeployment(chainId);
  const client = publicClient(chainId);

  let receipt;
  try {
    receipt = await client.waitForTransactionReceipt({ hash: txHash, timeout: 30_000, pollingInterval: 500 });
  } catch {
    throw new CallerError("That transaction was not found on this chain (yet). Try again in a moment.", 404);
  }

  const base = {
    chainId,
    txHash: txHash.toLowerCase(),
    blockNumber: Number(receipt.blockNumber),
    trades: 0,
    claims: 0,
    graduations: 0,
  };
  if (receipt.status !== "success") return { ...base, ok: false, status: "reverted" };

  const curves = new Map<string, Pick<CurveRow, "token">>();
  for (const [curve, row] of await knownCurves(chainId)) curves.set(curve, { token: row.token });
  const written = await recordLogs(chainId, factory, receipt.logs as Log[], curves);

  // Which curves did this transaction trade on? One of them may now be full.
  const tradedCurves = new Set(
    (receipt.logs as Log[]).map((log) => log.address.toLowerCase()).filter((address) => curves.has(address)),
  );
  for (const curve of tradedCurves) invalidateCurve(chainId, curve);

  let autoGraduated: RecordResult["autoGraduated"] = null;
  for (const curve of tradedCurves) {
    autoGraduated = await maybeGraduate(chainId, curve, factory, curves).catch((error) => {
      console.warn("[juno record] auto-graduate failed:", error instanceof Error ? error.message : error);
      return null;
    });
    if (autoGraduated) break;
  }

  return {
    ...base,
    ok: true,
    status: "success",
    launched: written.launched[0],
    trades: written.trades,
    claims: written.claims,
    graduations: written.graduations,
    autoGraduated,
  };
}

/**
 * Plan flow F: once a buy fills a curve, the server calls the permissionless
 * `graduate()` itself (test networks only, from the faucet key, a few cents of test
 * gas), so a full curve never sits waiting for someone to push it. Set
 * `JUNO_AUTO_GRADUATE=0` to turn it off.
 */
async function maybeGraduate(
  chainId: ChainId,
  curve: string,
  factory: string,
  curves: Map<string, Pick<CurveRow, "token">>,
): Promise<{ curve: string; txHash: string } | null> {
  if (!isTestnet(chainId) || process.env.JUNO_AUTO_GRADUATE === "0" || !process.env.FAUCET_PRIVATE_KEY) return null;
  const state = await readCurveState(chainId, curve);
  if (state.graduated || state.sold < state.curveSupply) return null;

  const account = faucetAccount();
  const wallet = createWalletClient({
    account,
    chain: viemChain(chainId),
    transport: fallback(rpcUrls(chainId).map((url) => http(url, { timeout: 20_000 }))),
  });
  const { request } = await publicClient(chainId).simulateContract({
    account,
    address: curve as Hex,
    abi: junoCurveAbi,
    functionName: "graduate",
  });
  const hash = await wallet.writeContract(request);
  const receipt = await publicClient(chainId).waitForTransactionReceipt({ hash, timeout: 45_000 });
  await recordLogs(chainId, factory, receipt.logs as Log[], curves);
  invalidateCurve(chainId, curve);
  return { curve, txHash: hash };
}
