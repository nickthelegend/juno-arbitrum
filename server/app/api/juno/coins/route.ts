import { maybeAddress } from "@/lib/juno/address";
import { junoJson, junoOptions, junoRead } from "@/lib/juno/api";
import { hydrateCurves } from "@/lib/juno/chain";
import { chainIdFromUrl, requireDeployment } from "@/lib/juno/chains";
import { listCurves } from "@/lib/juno/registry";
import { socialCounts } from "@/lib/juno/social";
import type { Coin } from "@/lib/juno/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const OPTIONS = junoOptions;

/**
 * The market list: every listed Juno coin on this chain, priced.
 *
 * `?sort=marketCap|graduating`, `?kind=post|stock`, `?nav=1` (trackers'
 * Chainlink marks), `?social=1&viewer=0x…` (likes and comment counts).
 */
export async function GET(request: Request) {
  return junoRead(async () => {
    const url = new URL(request.url);
    const chainId = chainIdFromUrl(url);
    requireDeployment(chainId);
    const limit = Math.min(Number(url.searchParams.get("limit") ?? 40) || 40, 100);
    const kind = url.searchParams.get("kind");

    let rows = await listCurves(chainId, limit, { listedOnly: true });
    if (kind === "stock") rows = rows.filter((row) => row.feed);
    if (kind === "post") rows = rows.filter((row) => !row.feed);

    const { coins, missing } = await hydrateCurves(rows, { nav: url.searchParams.get("nav") === "1" });

    const sort = url.searchParams.get("sort");
    if (sort === "marketCap") coins.sort((a, b) => b.marketCap - a.marketCap);
    else if (sort === "graduating") {
      // Closest to graduation first; already-graduated markets drop to the bottom.
      const rank = (coin: Coin) => (coin.curve.graduated ? -1 : coin.curve.progress);
      coins.sort((a, b) => rank(b) - rank(a));
    } else if (sort === "volume") coins.sort((a, b) => (b.volume24h ?? 0) - (a.volume24h ?? 0));

    if (url.searchParams.get("social") === "1") {
      const counts = await socialCounts(
        coins.map((coin) => coin.address),
        chainId,
        maybeAddress(url.searchParams.get("viewer")),
      ).catch(() => null);
      if (counts) {
        for (const coin of coins) {
          const entry = counts.get(coin.address);
          if (!entry) continue;
          coin.likes = entry.likes;
          coin.commentCount = entry.comments;
          coin.viewerLiked = entry.viewerLiked;
        }
      }
    }

    return junoJson({ chainId, coins, missing });
  });
}
