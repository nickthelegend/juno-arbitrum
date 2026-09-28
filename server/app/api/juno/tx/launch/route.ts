import { normAddress } from "@/lib/juno/address";
import { junoHandler, junoJson, junoOptions, readJson, requireString, retryWhenBusy } from "@/lib/juno/api";
import { resolveChainId } from "@/lib/juno/chains";
import { buildLaunch, parseAmount } from "@/lib/juno/tx";
import type { CurvePresetId } from "@/lib/juno/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const OPTIONS = junoOptions;

/**
 * Build `factory.launch` for a post or reel.
 * `POST { chainId, creator, name, symbol, metadataUri, format, preset, initialBuy? }`
 * → `{ chainId, steps, quote }`. Trackers launch from `scripts/`, not here.
 */
export async function POST(request: Request) {
  return junoHandler(async () => {
    const body = await readJson<Record<string, unknown>>(request);
    const chainId = resolveChainId(body.chainId);
    const initialBuy =
      body.initialBuy === undefined || body.initialBuy === null || body.initialBuy === "" || body.initialBuy === "0"
        ? undefined
        : parseAmount(body.initialBuy, 18, "initialBuy");
    const capMultiple = body.capMultiple === undefined ? undefined : Number(body.capMultiple);

    const build = await retryWhenBusy(() =>
      buildLaunch({
        chainId,
        creator: normAddress(body.creator, "creator"),
        name: requireString(body.name, "name"),
        symbol: requireString(body.symbol, "symbol").toUpperCase(),
        metadataUri: requireString(body.metadataUri ?? body.uri, "metadataUri"),
        format: (typeof body.format === "string" ? body.format : "post") as "post" | "reel",
        preset: (typeof body.preset === "string" ? body.preset : "content") as CurvePresetId,
        initialBuy,
        capMultiple: Number.isFinite(capMultiple) ? capMultiple : undefined,
      }),
    );
    return junoJson(build);
  });
}
