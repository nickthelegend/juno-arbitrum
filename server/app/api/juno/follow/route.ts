import { normAddress } from "@/lib/juno/address";
import { junoHandler, junoJson, junoOptions, readJson } from "@/lib/juno/api";
import { chainIdFromUrl, resolveChainId } from "@/lib/juno/chains";
import { follow, followStats, following, unfollow } from "@/lib/juno/social-graph";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const OPTIONS = junoOptions;

/** `GET ?wallet=&viewer=&chainId=` — counts, the list it follows, and whether the viewer follows it. */
export async function GET(request: Request) {
  return junoHandler(async () => {
    const url = new URL(request.url);
    const chainId = chainIdFromUrl(url);
    const wallet = normAddress(url.searchParams.get("wallet"), "wallet");
    const [stats, targets] = await Promise.all([
      followStats(chainId, wallet, url.searchParams.get("viewer")),
      following(chainId, wallet),
    ]);
    return junoJson({ wallet, ...stats, followingList: targets });
  });
}

/** `POST { chainId, follower, target, follow: boolean }` — idempotent both ways. */
export async function POST(request: Request) {
  return junoHandler(async () => {
    const body = await readJson<Record<string, unknown>>(request);
    const chainId = resolveChainId(body.chainId);
    const follower = normAddress(body.follower, "follower");
    const target = normAddress(body.target, "target");
    const on = body.follow !== false;
    if (on) await follow(chainId, follower, target);
    else await unfollow(chainId, follower, target);
    const stats = await followStats(chainId, target, follower);
    return junoJson({ target, isFollowing: on, ...stats });
  });
}
