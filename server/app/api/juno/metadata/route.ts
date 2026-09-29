import { maybeAddress } from "@/lib/juno/address";
import { CallerError, junoHandler, junoJson, junoOptions, readJson } from "@/lib/juno/api";
import { isPresetId } from "@/lib/juno/curves";
import { buildMetadata } from "@/lib/juno/metadata";
import { pinJson } from "@/lib/juno/pinata";
import { requireSession } from "@/lib/juno/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const OPTIONS = junoOptions;

/**
 * Pin the metadata JSON a launch points at. Called before `tx/launch`,
 * because the URI is baked into the token when it is created.
 *
 * `POST { name, symbol, description?, imageUrl|mediaUrl?, mimeType?, posterUrl?,
 * format?, creator?, width?, height?, curvePreset?, externalUrl? }` → `{ cid, uri, url, metadata }`.
 */
export async function POST(request: Request) {
  return junoHandler(async () => {
    if (!process.env.PINATA_JWT) throw new CallerError("Metadata pinning is not configured", 503);
    const body = await readJson<Record<string, unknown>>(request);
    // Pinning spends Juno's Pinata quota: signed-in wallets only, and a named
    // creator must be the caller.
    const session = requireSession(request);
    const creatorInput = maybeAddress(body.creator);
    if (creatorInput && creatorInput !== session.wallet) throw new CallerError("creator must be your own wallet", 403);
    const str = (key: string) => (typeof body[key] === "string" ? (body[key] as string).trim() : "");
    const num = (key: string) => (typeof body[key] === "number" && Number.isFinite(body[key]) ? (body[key] as number) : null);

    const name = str("name");
    const symbol = str("symbol").toUpperCase();
    if (!name || !symbol) throw new CallerError("name and symbol are required");
    const format = str("format");
    if (format && format !== "post" && format !== "reel") throw new CallerError('"format" must be "post" or "reel"');

    // `mediaMime` names the media's own type when a caller put the poster's in
    // `mimeType` (older app builds sent the poster as `imageUrl`/`mimeType`).
    const mediaMime = str("mediaMime") || str("mimeType");
    const mediaUrl = str("mediaUrl") || str("imageUrl");
    const imageUrl = str("imageUrl");
    const posterUrl =
      str("posterUrl") || str("posterUri") || (mediaMime.startsWith("video") && imageUrl && imageUrl !== mediaUrl ? imageUrl : "");

    const metadata = buildMetadata({
      name,
      symbol,
      description: str("description"),
      mediaUrl: mediaUrl || undefined,
      mimeType: mediaMime || undefined,
      posterUrl: posterUrl || undefined,
      format: (format || undefined) as "post" | "reel" | undefined,
      creator: maybeAddress(body.creator) ?? undefined,
      width: num("width"),
      height: num("height"),
      preset: isPresetId(body.curvePreset) ? body.curvePreset : undefined,
      externalUrl: str("externalUrl") || undefined,
    });

    try {
      const pinned = await pinJson(metadata, `juno-${symbol}-metadata`);
      return junoJson({ ...pinned, metadata }, { status: 201 });
    } catch (error) {
      return junoJson({ error: error instanceof Error ? error.message : "Pin failed" }, { status: 502 });
    }
  });
}
