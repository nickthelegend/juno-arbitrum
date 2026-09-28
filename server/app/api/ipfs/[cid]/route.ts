import { gateways, isCid } from "@/lib/juno/media";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The app's own IPFS gateway: fails over across public gateways server-side
 * and caches immutably (content is addressed by hash). Range is forwarded so
 * video can seek.
 */
export async function GET(request: Request, { params }: { params: Promise<{ cid: string }> }) {
  const { cid } = await params;
  if (!isCid(cid)) return Response.json({ error: "Not a content hash" }, { status: 400 });

  const range = request.headers.get("range");
  for (const gateway of gateways()) {
    try {
      const response = await fetch(`${gateway}/${cid}`, {
        headers: range ? { range } : undefined,
        signal: AbortSignal.timeout(30_000),
        cache: "no-store",
      });
      if (!response.ok && response.status !== 206) continue;
      const headers: Record<string, string> = {
        "content-type": response.headers.get("content-type") ?? "application/octet-stream",
        "accept-ranges": "bytes",
        "cache-control": "public, max-age=31536000, immutable",
        "access-control-allow-origin": "*",
      };
      const length = response.headers.get("content-length");
      if (length) headers["content-length"] = length;
      const contentRange = response.headers.get("content-range");
      if (contentRange) headers["content-range"] = contentRange;
      return new Response(response.body, { status: response.status, headers });
    } catch {
      // next gateway
    }
  }
  return Response.json({ error: "No gateway could serve this content" }, { status: 502 });
}
