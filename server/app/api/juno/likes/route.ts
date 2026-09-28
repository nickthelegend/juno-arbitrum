import { isAddr, maybeAddress, normAddress } from "@/lib/juno/address";
import { CallerError, junoHandler, junoJson, junoOptions, readJson } from "@/lib/juno/api";
import { chainIdFromUrl, resolveChainId } from "@/lib/juno/chains";
import { getCurve } from "@/lib/juno/registry";
import { setLike, socialCounts } from "@/lib/juno/social";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const OPTIONS = junoOptions;

/**
 * `GET ?coins=a,b,c&viewer=&chainId=` — counts for up to 60 coins, plus whether
 * the viewer liked each. `POST { chainId, coin, wallet, like }` — idempotent.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const tokens = (url.searchParams.get("coins") ?? "")
    .split(",")
    .filter(isAddr)
    .map((token) => token.toLowerCase())
    .slice(0, 60);
  const viewerParam = url.searchParams.get("viewer");
  const viewer = maybeAddress(viewerParam);
  return junoHandler(async () => {
    const chainId = chainIdFromUrl(url);
    if (viewerParam && !viewer) throw new CallerError("viewer is not an address");
    try {
      const counts = await socialCounts(tokens, chainId, viewer);
      return junoJson({ counts: Object.fromEntries(counts) });
    } catch (error) {
      // Mongo down. Market data never depends on this, so neither does the screen.
      return junoJson(
        { counts: {}, error: error instanceof Error ? error.message : "Likes are unavailable" },
        { status: 503 },
      );
    }
  });
}

export async function POST(request: Request) {
  return junoHandler(async () => {
    const body = await readJson<Record<string, unknown>>(request);
    const chainId = resolveChainId(body.chainId);
    const token = normAddress(body.coin ?? body.token, "coin");
    const wallet = normAddress(body.wallet, "wallet");
    const row = await getCurve(token, chainId);
    if (!row) throw new CallerError("No such coin", 404);
    const result = await setLike({ token: row.token, chainId, wallet, like: body.like !== false });
    return junoJson({ coin: row.token, ...result });
  });
}
