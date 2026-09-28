import { formatUnits } from "viem";

import { normAddress } from "@/lib/juno/address";
import { junoJson, junoOptions, junoRead } from "@/lib/juno/api";
import { chainIdFromUrl, deployment } from "@/lib/juno/chains";
import { ethBalance, tokenBalances } from "@/lib/juno/onchain";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const OPTIONS = junoOptions;

/**
 * What a wallet can spend: `GET ?wallet=&chainId=[&token=]` →
 * `{ eth, usdc, token? }`, whole units. `usdc` is 0 on a chain without Juno's
 * USDC; `token` (the given token's balance) only when `token` was asked for.
 * A read that failed is `null` — not zero, which would grey out a button over
 * a network hiccup.
 */
export async function GET(request: Request) {
  return junoRead(async () => {
    const url = new URL(request.url);
    const chainId = chainIdFromUrl(url);
    const wallet = normAddress(url.searchParams.get("wallet"), "wallet");
    const tokenParam = url.searchParams.get("token") ?? url.searchParams.get("mint");
    const token = tokenParam ? normAddress(tokenParam, "token") : null;
    const usdc = deployment(chainId)?.usdc ?? null;

    const pairs = [
      ...(usdc ? [{ token: usdc, owner: wallet }] : []),
      ...(token ? [{ token, owner: wallet }] : []),
    ];
    const [eth, balances] = await Promise.all([
      ethBalance(chainId, wallet).catch(() => null),
      tokenBalances(chainId, pairs).catch(() => pairs.map(() => null)),
    ]);
    const read = (raw: bigint | null | undefined, decimals: number) =>
      raw === null || raw === undefined ? null : Number(formatUnits(raw, decimals));

    return junoJson({
      chainId,
      wallet,
      eth: read(eth, 18),
      usdc: usdc ? read(balances[0], 6) : 0,
      ...(token ? { token: read(balances[usdc ? 1 : 0], token === usdc ? 6 : 18) } : {}),
    });
  });
}
