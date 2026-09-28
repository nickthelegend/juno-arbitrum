import { normAddress } from "@/lib/juno/address";
import { CallerError, junoHandler, junoJson, junoOptions, readJson, retryWhenBusy } from "@/lib/juno/api";
import { requireDeployment, resolveChainId } from "@/lib/juno/chains";
import { getCurve } from "@/lib/juno/registry";
import { buildClaim } from "@/lib/juno/tx";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const OPTIONS = junoOptions;

/** Build `claimCreatorFees()`. `POST { chainId, curve|token, creator }`. Creator only. */
export async function POST(request: Request) {
  return junoHandler(async () => {
    const body = await readJson<Record<string, unknown>>(request);
    const chainId = resolveChainId(body.chainId);
    requireDeployment(chainId);
    const address = normAddress(body.curve ?? body.token ?? body.mint, "curve");
    const owner = normAddress(body.creator ?? body.owner, "creator");
    const row = await getCurve(address, chainId);
    if (!row) throw new CallerError("Coin not found", 404);
    return junoJson(await retryWhenBusy(() => buildClaim({ chainId, row, owner })));
  });
}
