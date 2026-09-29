import { maybeAddress, normAddress } from "@/lib/juno/address";
import { junoHandler, junoJson, junoOptions, readJson, requireString } from "@/lib/juno/api";
import { chainIdFromUrl, resolveChainId } from "@/lib/juno/chains";
import { createPost, listPosts } from "@/lib/juno/posts";
import { requireSession } from "@/lib/juno/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const OPTIONS = junoOptions;

export async function GET(request: Request) {
  return junoHandler(async () => {
    const url = new URL(request.url);
    const chainId = chainIdFromUrl(url);
    const before = url.searchParams.get("before");
    const posts = await listPosts(chainId, {
      limit: Number(url.searchParams.get("limit") ?? 30) || 30,
      before: before ? new Date(before) : undefined,
      authorWallet: maybeAddress(url.searchParams.get("author")) ?? undefined,
      token: maybeAddress(url.searchParams.get("token") ?? url.searchParams.get("mint")) ?? undefined,
    });
    return junoJson({ chainId, posts });
  });
}

/**
 * Write a post, as the wallet whose session the request carries: the author
 * is proven, but by the one session signature rather than a prompt per post.
 */
export async function POST(request: Request) {
  return junoHandler(async () => {
    const body = await readJson<Record<string, unknown>>(request);
    const tokenInput = body.token ?? body.baseMint;
    const authorWallet = normAddress(body.authorWallet, "authorWallet");
    requireSession(request, authorWallet);
    const post = await createPost({
      chainId: resolveChainId(body.chainId),
      authorWallet,
      body: requireString(body.body, "body"),
      token: tokenInput ? normAddress(tokenInput, "token") : null,
      mediaUrl: typeof body.mediaUrl === "string" ? body.mediaUrl : null,
      mediaMime: typeof body.mediaMime === "string" ? body.mediaMime : null,
      parentId: typeof body.parentId === "string" ? body.parentId : null,
    });
    return junoJson({ post }, { status: 201 });
  });
}
