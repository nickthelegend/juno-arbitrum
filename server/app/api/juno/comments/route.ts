import { normAddress } from "@/lib/juno/address";
import { CallerError, junoHandler, junoJson, junoOptions, readJson } from "@/lib/juno/api";
import { chainIdFromUrl, resolveChainId } from "@/lib/juno/chains";
import { getCurve } from "@/lib/juno/registry";
import { requireSession } from "@/lib/juno/session";
import { addComment, listComments, MAX_COMMENT } from "@/lib/juno/social";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const OPTIONS = junoOptions;

/** `GET ?coin=0x…&chainId=` — comments on a coin, newest first. */
export async function GET(request: Request) {
  return junoHandler(async () => {
    const url = new URL(request.url);
    const chainId = chainIdFromUrl(url);
    const token = normAddress(url.searchParams.get("coin") ?? url.searchParams.get("token"), "coin");
    return junoJson({ comments: await listComments(token, chainId) });
  });
}

/** `POST { chainId, coin|token, wallet, body, side?, txHash? }`, with the wallet's session. */
export async function POST(request: Request) {
  return junoHandler(async () => {
    const body = await readJson<Record<string, unknown>>(request);
    const chainId = resolveChainId(body.chainId);
    const token = normAddress(body.coin ?? body.token, "coin");
    const wallet = normAddress(body.wallet, "wallet");
    requireSession(request, wallet);
    const text = typeof body.body === "string" ? body.body.trim() : "";
    if (!text) throw new CallerError("Comment is empty");
    if (text.length > MAX_COMMENT) throw new CallerError(`Comment is over ${MAX_COMMENT} characters`);

    // Only coins Juno launched; otherwise this is an open write keyed on any string.
    const row = await getCurve(token, chainId);
    if (!row) throw new CallerError("No such coin", 404);

    const txInput = body.txHash ?? body.signature;
    const txHash = typeof txInput === "string" && /^0x[0-9a-fA-F]{64}$/.test(txInput) ? txInput.toLowerCase() : undefined;
    const comment = await addComment({
      token: row.token,
      chainId,
      wallet,
      body: text,
      side: body.side === "buy" || body.side === "sell" ? body.side : undefined,
      txHash,
    });
    return junoJson({ comment }, { status: 201 });
  });
}
