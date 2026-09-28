import { normAddress } from "@/lib/juno/address";
import { junoHandler, junoJson, junoOptions } from "@/lib/juno/api";
import { chainIdFromUrl } from "@/lib/juno/chains";
import { plans, watchlist } from "@/lib/juno/social-graph";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const OPTIONS = junoOptions;

/** One wallet's relationship to one coin: watching it, and any plans against it. `GET ?wallet=&baseMint=`. */
export async function GET(request: Request) {
  return junoHandler(async () => {
    const url = new URL(request.url);
    const chainId = chainIdFromUrl(url);
    const wallet = normAddress(url.searchParams.get("wallet"), "wallet");
    const token = normAddress(url.searchParams.get("baseMint") ?? url.searchParams.get("token"), "baseMint");
    const [watched, owned] = await Promise.all([watchlist(chainId, wallet), plans(chainId, wallet)]);
    const row = watched.find((item) => item.token === token) ?? null;
    return junoJson({
      wallet,
      baseMint: token,
      token,
      watching: row !== null,
      alertPrice: row?.alertPrice ?? null,
      alertSetAtPrice: row?.alertSetAtPrice ?? null,
      plans: owned.filter((plan) => plan.token === token),
    });
  });
}
