import { CallerError, junoHandler, junoJson, junoOptions, readJson, requireString } from "@/lib/juno/api";
import { resolveChainId } from "@/lib/juno/chains";
import { recordTransaction } from "@/lib/juno/record";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 90;
export const OPTIONS = junoOptions;

/**
 * `POST { chainId, txHash }` after the last step's receipt. Reads the receipt,
 * records its `Launched` / `Trade` / claim / graduation logs at once, and
 * returns `{ ok, launched?: { token, curve }, trades }`.
 */
export async function POST(request: Request) {
  return junoHandler(async () => {
    const body = await readJson<Record<string, unknown>>(request);
    const chainId = resolveChainId(body.chainId);
    const txHash = requireString(body.txHash ?? body.hash, "txHash").toLowerCase();
    if (!/^0x[0-9a-f]{64}$/.test(txHash)) throw new CallerError("txHash is not a transaction hash");
    return junoJson(await recordTransaction(chainId, txHash as `0x${string}`));
  });
}
