import { junoJson, junoOptions, junoRead } from "@/lib/juno/api";
import { chainIdFromUrl, requireDeployment } from "@/lib/juno/chains";
import { leaderboard } from "@/lib/juno/leaderboard";
import { followerCounts } from "@/lib/juno/social-graph";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const OPTIONS = junoOptions;

/** Traders ranked by profit they have actually taken, from recorded trades. */
export async function GET(request: Request) {
  return junoRead(async () => {
    const url = new URL(request.url);
    const chainId = chainIdFromUrl(url);
    requireDeployment(chainId);
    const limit = Math.min(Number(url.searchParams.get("limit") ?? 20) || 20, 50);
    const board = await leaderboard(chainId);
    const top = board.traders.slice(0, limit);
    const followers = await followerCounts(chainId, top.map((trader) => trader.wallet)).catch(() => new Map<string, number>());
    return junoJson({
      chainId,
      partial: board.partial,
      poolsRead: board.poolsRead,
      poolsTotal: board.poolsTotal,
      traders: top.map((trader) => ({ ...trader, followers: followers.get(trader.wallet) ?? 0 })),
    });
  });
}
