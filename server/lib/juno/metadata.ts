import { gatewayUrlFor, gateways, mediaCid } from "./media";

/**
 * Token metadata JSON: what Juno pins before a launch and what the indexer
 * reads back after one.
 *
 * ERC-721-style fields so wallets and explorers render it without special
 * cases: `{ name, symbol, description, image, animation_url?, external_url,
 * properties: { format, creator, … } }`. For a reel, `animation_url` is the
 * video and `image` its poster frame.
 */

export type TokenMetadata = {
  name: string;
  symbol: string;
  description: string;
  image: string;
  animation_url?: string;
  external_url: string;
  properties: {
    format: "post" | "reel";
    creator: string;
    /** Mime type of the main media (the video, for a reel). */
    mimeType?: string;
    width?: number;
    height?: number;
    preset?: string;
    launchpad: "Juno";
  };
};

export type MetadataInput = {
  name: string;
  symbol: string;
  description?: string;
  /** The uploaded media (image, or the video of a reel). */
  mediaUrl?: string;
  mimeType?: string;
  /** A reel's poster frame. */
  posterUrl?: string;
  format?: "post" | "reel";
  creator?: string;
  width?: number | null;
  height?: number | null;
  preset?: string;
  externalUrl?: string;
};

export function buildMetadata(input: MetadataInput): TokenMetadata {
  const isVideo = input.mimeType?.startsWith("video") ?? false;
  const format = input.format ?? (isVideo ? "reel" : "post");
  const media = input.mediaUrl ? gatewayUrlFor(input.mediaUrl) : "";
  const poster = input.posterUrl ? gatewayUrlFor(input.posterUrl) : "";
  const metadata: TokenMetadata = {
    name: input.name,
    symbol: input.symbol,
    description: input.description ?? "",
    image: isVideo ? poster || media : media,
    external_url: input.externalUrl ?? "",
    properties: {
      format,
      creator: (input.creator ?? "").toLowerCase(),
      launchpad: "Juno",
    },
  };
  if (isVideo && media) metadata.animation_url = media;
  if (input.mimeType) metadata.properties.mimeType = input.mimeType;
  if (input.width) metadata.properties.width = input.width;
  if (input.height) metadata.properties.height = input.height;
  if (input.preset) metadata.properties.preset = input.preset;
  return metadata;
}

/** What the registry row needs from a metadata document. */
export type ParsedMetadata = {
  description: string | null;
  format: "post" | "reel";
  mediaUrl: string | null;
  posterUrl: string | null;
  mediaMime: string | null;
  mediaWidth: number | null;
  mediaHeight: number | null;
};

export function parseMetadata(raw: unknown): ParsedMetadata {
  const doc = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const props = (doc.properties && typeof doc.properties === "object" ? doc.properties : {}) as Record<string, unknown>;
  const str = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null);
  const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : null);

  const animation = str(doc.animation_url);
  const image = str(doc.image);
  const declaredMime = str(props.mimeType);
  const isVideo = !!animation || (declaredMime?.startsWith("video") ?? false);
  const format = props.format === "reel" || props.format === "post" ? props.format : isVideo ? "reel" : "post";

  return {
    description: str(doc.description),
    format,
    mediaUrl: isVideo ? (animation ?? image) : image,
    posterUrl: isVideo ? image : null,
    mediaMime: declaredMime ?? (isVideo ? "video/mp4" : image ? "image/jpeg" : null),
    mediaWidth: num(props.width),
    mediaHeight: num(props.height),
  };
}

/** Fetch a metadata document from `ipfs://`, a gateway, https or a data URI. */
export async function fetchMetadata(uri: string, timeoutMs = 8_000): Promise<unknown | null> {
  const trimmed = uri.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("data:")) {
    const comma = trimmed.indexOf(",");
    const body = trimmed.slice(comma + 1);
    const text = trimmed.slice(0, comma).includes(";base64")
      ? Buffer.from(body, "base64").toString("utf8")
      : decodeURIComponent(body);
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }
  const cid = mediaCid(trimmed);
  const path = cid ? trimmed.slice(trimmed.indexOf(cid) + cid.length).split("?")[0] : "";
  const urls = cid ? gateways().map((gateway) => `${gateway}/${cid}${path}`) : /^https?:\/\//.test(trimmed) ? [trimmed] : [];
  for (const url of urls) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), cache: "no-store" });
      if (!response.ok) continue;
      return await response.json();
    } catch {
      // next gateway
    }
  }
  return null;
}
