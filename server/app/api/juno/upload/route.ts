import sharp from "sharp";

import { CallerError, junoJson, junoOptions } from "@/lib/juno/api";
import { pinFile } from "@/lib/juno/pinata";
import { requireSession } from "@/lib/juno/session";
import { videoPoster } from "@/lib/juno/poster";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;
export const OPTIONS = junoOptions;

const MAX_BYTES = 25 * 1024 * 1024;
const ALLOWED = /^(image|video)\//;

/**
 * Pin a photo or video to IPFS (multipart field `file`). A video comes back
 * with a pinned poster frame and its dimensions; an image with its size.
 */
export async function POST(request: Request) {
  if (!process.env.PINATA_JWT) return junoJson({ error: "Uploads are not configured" }, { status: 503 });
  // Pinning spends Juno's Pinata quota: signed-in wallets only.
  try {
    requireSession(request);
  } catch (error) {
    if (error instanceof CallerError) return junoJson({ error: error.message, ...error.extra }, { status: error.status });
    throw error;
  }

  // Only what this route reads: two FormData types are visible at build time.
  let form: { get(name: string): unknown };
  try {
    form = (await request.formData()) as unknown as typeof form;
  } catch {
    return junoJson({ error: "Expected multipart form data" }, { status: 400 });
  }

  const file = form.get("file");
  if (!(file instanceof File)) return junoJson({ error: "No file" }, { status: 400 });
  if (!ALLOWED.test(file.type)) return junoJson({ error: "Only images and video" }, { status: 415 });
  if (file.size > MAX_BYTES) return junoJson({ error: "File is over 25MB" }, { status: 413 });

  try {
    const pinned = await pinFile(file);
    const bytes = Buffer.from(await file.arrayBuffer());

    if (file.type.startsWith("video/")) {
      const poster = await videoPoster(bytes);
      const pinnedPoster = await pinFile(
        new File([new Uint8Array(poster.jpeg)], "poster.jpg", { type: "image/jpeg" }),
        `${file.name || "reel"}-poster`,
      );
      return junoJson(
        {
          ...pinned,
          mimeType: file.type,
          posterUri: pinnedPoster.uri,
          posterUrl: pinnedPoster.url,
          width: poster.width,
          height: poster.height,
        },
        { status: 201 },
      );
    }

    const meta = await sharp(bytes)
      .metadata()
      .catch(() => ({ width: undefined, height: undefined }));
    return junoJson(
      { ...pinned, mimeType: file.type, width: meta.width ?? null, height: meta.height ?? null },
      { status: 201 },
    );
  } catch (error) {
    return junoJson({ error: error instanceof Error ? error.message : "Upload failed" }, { status: 502 });
  }
}
