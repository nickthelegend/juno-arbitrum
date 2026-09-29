import { normAddress } from "@/lib/juno/address";
import { junoHandler, junoJson, junoOptions, readJson } from "@/lib/juno/api";
import { chainIdFromUrl, resolveChainId } from "@/lib/juno/chains";
import { drip, faucetEligibility, faucetStatus } from "@/lib/juno/faucet";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;
export const OPTIONS = junoOptions;

/**
 * `GET ?chainId=` — the faucet's address, balance and what it sends. With
 * `&wallet=`, also whether that wallet (from this network) may drip now:
 * `eligibility: { eligible } | { eligible: false, scope, retryAfterSeconds, message }`.
 */
export async function GET(request: Request) {
  return junoHandler(async () => {
    const url = new URL(request.url);
    const chainId = chainIdFromUrl(url);
    const status = await faucetStatus(chainId);
    const walletInput = url.searchParams.get("wallet");
    if (!walletInput) return junoJson(status);
    const wallet = normAddress(walletInput, "wallet");
    return junoJson({ ...status, eligibility: await faucetEligibility(chainId, wallet, clientIp(request)) });
  });
}

/**
 * `POST { wallet, chainId }` — 0.02 ETH plus 1,000 Juno test USDC on Arbitrum
 * Sepolia → `{ eth: txHash, usdc: txHash | null }`. 429 with
 * `retryAfterSeconds` when rate-limited; 503 when the faucet is empty.
 */
export async function POST(request: Request) {
  return junoHandler(async () => {
    const body = await readJson<Record<string, unknown>>(request);
    const chainId = resolveChainId(body.chainId);
    const wallet = normAddress(body.wallet, "wallet");
    const ip = clientIp(request);
    return junoJson(await drip(chainId, wallet, ip));
  });
}

function clientIp(request: Request): string {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || request.headers.get("x-real-ip") || "unknown";
}
