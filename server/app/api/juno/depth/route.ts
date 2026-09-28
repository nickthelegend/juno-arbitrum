import { normAddress } from "@/lib/juno/address";
import { junoError, junoJson, junoOptions, junoRead } from "@/lib/juno/api";
import { chainIdFromUrl, requireDeployment, type ChainId } from "@/lib/juno/chains";
import { quoteUsdRate } from "@/lib/juno/chainlink";
import { depthCeiling, sampleDepth, suggestSize } from "@/lib/juno/depth";
import { readBoundaries, readCurveState } from "@/lib/juno/onchain";
import { getCurve } from "@/lib/juno/registry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const OPTIONS = junoOptions;

/**
 * What this curve can absorb. `GET ?mint|token=&side=buy|sell&max=&impact=`
 * returns a depth curve sampled across sizes (quoted by the curve's own
 * views) and, with `impact`, the largest trade that stays under it.
 */
export async function GET(request: Request) {
  return junoRead(async () => {
    const url = new URL(request.url);
    const chainId = chainIdFromUrl(url);
    requireDeployment(chainId);
    const address = normAddress(url.searchParams.get("token") ?? url.searchParams.get("mint"), "token");
    const side = url.searchParams.get("side") === "sell" ? "sell" : "buy";

    const row = await getCurve(address, chainId);
    if (!row) return junoError("Coin not found", 404);
    const state = await readCurveState(chainId, row.curve);
    if (state.graduated) return junoError("This market moved to Uniswap.", 400, { reason: "AlreadyGraduated" });

    const boundaries = await readBoundaries(row.chainId as ChainId, {
      curve: row.curve,
      preset: row.preset,
      p0: BigInt(row.p0),
      capFp: BigInt(row.capFp),
      curveSupply: BigInt(row.curveSupply),
    }).catch(() => null);

    const fallback = depthCeiling(row, state, side, boundaries);
    const asked = Number(url.searchParams.get("max"));
    const max = Number.isFinite(asked) && asked > 0 ? asked : fallback;

    const impact = Number(url.searchParams.get("impact"));
    const budget = Number.isFinite(impact) && impact > 0 ? impact : null;
    if (url.searchParams.has("impact") && budget === null) {
      return junoError("`impact` must be a ratio greater than zero, e.g. 0.01 for 1%");
    }

    const points = max > 0 ? await sampleDepth(chainId, row, state, side, max) : [];
    const suggestion = budget === null || !(max > 0) ? null : await suggestSize(chainId, row, state, side, budget, max);
    const rate = await quoteUsdRate(row.quoteSymbol).catch(() => null);

    return junoJson({
      chainId,
      mint: row.token,
      token: row.token,
      side,
      spot: Number(state.price) / 10 ** row.quoteDecimals,
      quoteSymbol: row.quoteSymbol,
      quoteUsdRate: rate,
      max,
      points,
      suggestion,
    });
  });
}
