import { createReadStream } from "node:fs";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import { junoJson, junoOptions } from "@/lib/juno/api";
import { gateways, isCid } from "@/lib/juno/media";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const OPTIONS = junoOptions;

/**
 * The app's own IPFS gateway: fails over across public gateways server-side
 * and caches immutably (content is addressed by hash). Range is served so
 * video can seek.
 *
 * Each object is also kept in a content-addressed file on this server. The
 * public gateways are slow to first byte (Pinata's ~6 s for a 37 KB poster)
 * or rate-limited, so without it every reel waited on the gateway again
 * wherever no CDN sits in front: the local stack, and a cold function. A
 * hash's content never changes, so the copy is never stale.
 */
const CACHE_DIR = join(tmpdir(), "juno-ipfs");
/** Larger objects stream straight through instead of being kept. */
const MAX_CACHED_BYTES = 30 * 1024 * 1024;

const baseHeaders = (type: string): Record<string, string> => ({
  "content-type": type,
  "accept-ranges": "bytes",
  "cache-control": "public, max-age=31536000, immutable",
  "access-control-allow-origin": "*",
});

export async function GET(request: Request, { params }: { params: Promise<{ cid: string }> }) {
  const { cid } = await params;
  if (!isCid(cid)) return junoJson({ error: "Not a content hash" }, { status: 400 });
  const range = request.headers.get("range");

  const cached = await fromCache(cid, range);
  if (cached) return cached;

  for (const gateway of gateways()) {
    try {
      const response = await fetch(`${gateway}/${cid}`, { signal: AbortSignal.timeout(30_000), cache: "no-store" });
      if (!response.ok) continue;
      const type = response.headers.get("content-type") ?? "application/octet-stream";
      const length = Number(response.headers.get("content-length") ?? "0");
      if (length > 0 && length <= MAX_CACHED_BYTES) {
        const bytes = Buffer.from(await response.arrayBuffer());
        await keep(cid, bytes, type).catch(() => undefined);
        return serve(bytes.length, type, range, (start, end) => Readable.toWeb(Readable.from([bytes.subarray(start, end + 1)])) as ReadableStream);
      }
      // Too large (or unsized) to keep: pass it through, as before.
      const headers = baseHeaders(type);
      if (length) headers["content-length"] = String(length);
      return new Response(response.body, { status: 200, headers });
    } catch {
      // next gateway
    }
  }
  return junoJson({ error: "No gateway could serve this content" }, { status: 502 });
}

async function keep(cid: string, bytes: Buffer, type: string): Promise<void> {
  await mkdir(CACHE_DIR, { recursive: true });
  const file = join(CACHE_DIR, cid);
  // Written beside and renamed into place, so a reader never sees half a file.
  const partial = `${file}.${process.pid}.${Date.now()}.part`;
  await writeFile(partial, bytes);
  await writeFile(`${file}.type`, type);
  await rename(partial, file);
}

async function fromCache(cid: string, range: string | null): Promise<Response | null> {
  const file = join(CACHE_DIR, cid);
  try {
    const [info, type] = await Promise.all([stat(file), readFile(`${file}.type`, "utf8")]);
    return serve(info.size, type, range, (start, end) => Readable.toWeb(createReadStream(file, { start, end })) as ReadableStream);
  } catch {
    return null;
  }
}

/** A whole object, or the byte range asked for (`bytes=a-b`, `bytes=a-`, `bytes=-n`). */
function serve(size: number, type: string, range: string | null, body: (start: number, end: number) => ReadableStream): Response {
  const headers = baseHeaders(type);
  const match = range?.match(/^bytes=(\d*)-(\d*)$/);
  if (!match || (match[1] === "" && match[2] === "")) {
    headers["content-length"] = String(size);
    return new Response(size ? body(0, size - 1) : null, { status: 200, headers });
  }
  let start: number;
  let end: number;
  if (match[1] === "") {
    start = Math.max(0, size - Number(match[2]));
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === "" ? size - 1 : Math.min(Number(match[2]), size - 1);
  }
  if (start >= size || start > end) {
    return new Response(null, { status: 416, headers: { ...headers, "content-range": `bytes */${size}` } });
  }
  headers["content-length"] = String(end - start + 1);
  headers["content-range"] = `bytes ${start}-${end}/${size}`;
  return new Response(body(start, end), { status: 206, headers });
}
