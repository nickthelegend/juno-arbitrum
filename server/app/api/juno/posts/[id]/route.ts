import { junoError, junoHandler, junoJson, junoOptions } from "@/lib/juno/api";
import { hydrateCurve } from "@/lib/juno/chain";
import { deployment, type ChainId } from "@/lib/juno/chains";
import { identicon } from "@/lib/juno/identicon";
import { shortAddress } from "@/lib/juno/format";
import { mediaKind, mediaSrc } from "@/lib/juno/media";
import { getPost, listPosts, type JunoPostRow } from "@/lib/juno/posts";
import { getCurve } from "@/lib/juno/registry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const OPTIONS = junoOptions;

/** One post, its replies, and the coin it is about (priced; the post survives a failed price read). */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return junoHandler(async () => {
    const { id } = await params;
    const post = await getPost(id);
    // `?lookup=1` (the app's post page asking whether one exists): "no such
    // post" is an answer, not a 404.
    if (!post) {
      return new URL(request.url).searchParams.get("lookup") === "1" ? junoJson({ notFound: true }) : junoError("Post not found", 404);
    }
    const chainId = post.chainId as ChainId;

    const replies = await listPosts(chainId, { parentId: id, limit: 100 });
    const row = post.token && deployment(chainId) ? await getCurve(post.token, chainId) : null;
    const coin = row ? await hydrateCurve(row).catch(() => null) : null;

    const shape = (p: JunoPostRow) => ({
      id: p.id,
      body: p.body,
      timestamp: p.createdAt.toISOString(),
      author: { wallet: p.authorWallet, handle: shortAddress(p.authorWallet, 6, 4), avatarUrl: identicon(p.authorWallet) },
      mediaUrl: mediaSrc(p.mediaUrl),
      mediaKind: p.mediaMime ? mediaKind(p.mediaMime) : null,
    });

    return junoJson({
      chainId,
      post: shape(post),
      replies: replies.map(shape),
      replyCount: replies.length,
      coin: coin
        ? {
            address: coin.address,
            name: coin.name,
            symbol: coin.symbol,
            priceUsd: coin.priceUsd,
            marketCap: coin.marketCap,
            currency: coin.marketCapCurrency,
            changePct: coin.marketCapChangePct,
            progress: coin.curve.progress,
            graduated: coin.curve.graduated,
          }
        : null,
    });
  });
}
