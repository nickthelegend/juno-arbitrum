import "server-only";

import { createWalletClient, fallback, http, parseAbi, parseEther, parseUnits, type Hex } from "viem";
import { nonceManager, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";

import { CallerError } from "./api";
import { deployment, isTestnet, publicClient, rpcUrls, viemChain, type ChainId } from "./chains";
import { db, ensureIndexes } from "./social";

/**
 * The Arbitrum Sepolia faucet: 0.02 ETH and 1,000 Juno test USDC per wallet
 * per day, so a new user can buy a post and a stock tracker straight away.
 *
 * Rate limits live in Mongo (so they hold across server instances): one drip
 * per wallet per 24h and three per IP per 24h. A claim is written *before*
 * anything is sent and removed if sending fails, so two taps at once cannot
 * both get through.
 */

export const FAUCET_ETH = parseEther("0.02");
export const FAUCET_USDC = parseUnits("1000", 6);
/** Below this the faucet says it is empty rather than sending its last wei. */
export const FAUCET_FLOOR = parseEther("0.03");
export const WINDOW_MS = 24 * 60 * 60 * 1000;
export const PER_WALLET = 1;
export const PER_IP = 3;

const testUsdcAbi = parseAbi(["function mint(address to, uint256 amount)"]);

export type FaucetClaim = { wallet: string; ip: string; at: Date };

export type RateDecision =
  | { ok: true }
  | { ok: false; scope: "wallet" | "ip"; retryAfterSeconds: number };

/**
 * Pure: given the claims of the last day that match this wallet or IP, may it
 * drip now? The wait is measured from the oldest claim that still counts.
 */
export function rateDecision(claims: FaucetClaim[], wallet: string, ip: string, now = Date.now()): RateDecision {
  const recent = claims.filter((claim) => now - claim.at.getTime() < WINDOW_MS);
  const check = (scope: "wallet" | "ip", matches: FaucetClaim[], limit: number): RateDecision | null => {
    if (matches.length < limit) return null;
    const ordered = matches.map((claim) => claim.at.getTime()).sort((a, b) => b - a);
    // The claim whose expiry frees a slot is the limit-th most recent.
    const freeing = ordered[limit - 1];
    return { ok: false, scope, retryAfterSeconds: Math.max(1, Math.ceil((freeing + WINDOW_MS - now) / 1000)) };
  };
  return (
    check("wallet", recent.filter((claim) => claim.wallet === wallet), PER_WALLET) ??
    (ip && ip !== "unknown" ? check("ip", recent.filter((claim) => claim.ip === ip), PER_IP) : null) ?? { ok: true }
  );
}

export function retryMessage(decision: Extract<RateDecision, { ok: false }>): string {
  const total = Math.ceil(decision.retryAfterSeconds / 60);
  const hours = Math.floor(total / 60);
  const minutes = total % 60;
  const wait = hours > 0 ? `${hours}h ${minutes}m` : `${minutes} min`;
  return decision.scope === "wallet"
    ? `This wallet already used the faucet today. Try again in ${wait}.`
    : `Too many faucet requests from this network today. Try again in ${wait}.`;
}

let account: PrivateKeyAccount | null = null;

export function faucetAccount(): PrivateKeyAccount {
  if (account) return account;
  const key = process.env.FAUCET_PRIVATE_KEY?.trim();
  if (!key) throw new CallerError("The faucet is not configured.", 503);
  const normalised = (key.startsWith("0x") ? key : `0x${key}`) as Hex;
  account = privateKeyToAccount(normalised, { nonceManager });
  return account;
}

async function claimsCollection() {
  await ensureIndexes().catch(() => undefined);
  return (await db()).collection<FaucetClaim & { chainId: number }>("faucet_claims");
}

export async function faucetStatus(chainId: ChainId) {
  if (!isTestnet(chainId)) throw new CallerError("The faucet only runs on test networks.", 404);
  const faucet = faucetAccount();
  const balance = await publicClient(chainId).getBalance({ address: faucet.address });
  return {
    chainId,
    address: faucet.address.toLowerCase(),
    balanceEth: Number(balance) / 1e18,
    amountEth: Number(FAUCET_ETH) / 1e18,
    amountUsdc: deployment(chainId)?.usdc ? Number(FAUCET_USDC) / 1e6 : 0,
    empty: balance < FAUCET_FLOOR,
  };
}

export async function drip(chainId: ChainId, wallet: string, ip: string) {
  if (!isTestnet(chainId)) throw new CallerError("The faucet only runs on test networks.", 404);
  const faucet = faucetAccount();
  const client = publicClient(chainId);

  const balance = await client.getBalance({ address: faucet.address });
  if (balance < FAUCET_FLOOR) {
    throw new CallerError("The faucet is empty right now. Try again later.", 503, { reason: "FaucetEmpty" });
  }

  const claims = await claimsCollection();
  const since = new Date(Date.now() - WINDOW_MS);
  const recent = await claims
    .find({ chainId, at: { $gte: since }, $or: [{ wallet }, { ip }] })
    .toArray();
  const decision = rateDecision(recent, wallet, ip);
  if (!decision.ok) {
    throw new CallerError(retryMessage(decision), 429, { retryAfterSeconds: decision.retryAfterSeconds });
  }

  const { insertedId } = await claims.insertOne({ chainId, wallet, ip, at: new Date() });
  const walletClient = createWalletClient({
    account: faucet,
    chain: viemChain(chainId),
    transport: fallback(rpcUrls(chainId).map((url) => http(url, { timeout: 20_000 }))),
  });

  let ethHash: Hex;
  try {
    ethHash = await walletClient.sendTransaction({ to: wallet as Hex, value: FAUCET_ETH });
    await client.waitForTransactionReceipt({ hash: ethHash, timeout: 45_000 });
  } catch (error) {
    await claims.deleteOne({ _id: insertedId }).catch(() => undefined);
    throw error;
  }

  // USDC is a bonus: the ETH already landed, so a mint failure is reported, not thrown.
  let usdcHash: Hex | null = null;
  const usdc = deployment(chainId)?.usdc;
  if (usdc) {
    try {
      usdcHash = await walletClient.writeContract({
        address: usdc,
        abi: testUsdcAbi,
        functionName: "mint",
        args: [wallet as Hex, FAUCET_USDC],
      });
      await client.waitForTransactionReceipt({ hash: usdcHash, timeout: 45_000 });
    } catch (error) {
      console.warn("[juno faucet] USDC mint failed:", error instanceof Error ? error.message : error);
      usdcHash = null;
    }
  }

  return {
    chainId,
    wallet,
    eth: ethHash,
    usdc: usdcHash,
    amountEth: Number(FAUCET_ETH) / 1e18,
    amountUsdc: usdcHash ? Number(FAUCET_USDC) / 1e6 : 0,
  };
}
