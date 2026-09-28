/**
 * IPFS media addresses.
 *
 * Rows store content addresses (`ipfs://<cid>`, a gateway URL, or a bare CID),
 * and the app renders them through this server's own `/api/ipfs/<cid>` route,
 * which fails over across gateways — so a gateway's bad day is not the demo's.
 * Wallets and explorers, which cannot reach this app's routes, get a plain
 * gateway URL baked into the pinned metadata instead.
 */

const CID_V0 = /^Qm[1-9A-HJ-NP-Za-km-z]{44}$/;
const CID_V1 = /^b[a-z2-7]{58}$/;

export function isCid(value: string): boolean {
  return CID_V0.test(value) || CID_V1.test(value);
}

/** Pull a CID out of `ipfs://…`, a gateway URL, a bare CID, or `/api/ipfs/…`. */
export function mediaCid(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  const forms = [
    trimmed.startsWith("ipfs://") ? trimmed.slice(7).replace(/^ipfs\//, "") : null,
    trimmed.includes("/ipfs/") ? trimmed.split("/ipfs/")[1] : null,
    trimmed,
  ].filter((form): form is string => Boolean(form));

  for (const form of forms) {
    const candidate = form.split("/")[0].split("?")[0];
    if (isCid(candidate)) return candidate;
  }
  return null;
}

/** What the app renders with. A CID → our own route; anything else passes through. */
export function mediaSrc(value: string | null | undefined): string | null {
  if (!value) return null;
  const cid = mediaCid(value);
  if (cid) return `/api/ipfs/${cid}`;
  return value;
}

/** Image or video, decided by the stored mime type — never by the URL's tail. */
export function mediaKind(mime: string | null | undefined): "image" | "video" {
  return mime?.startsWith("video") ? "video" : "image";
}

export function ipfsGateway(): string {
  return process.env.NEXT_PUBLIC_IPFS_GATEWAY?.replace(/\/$/, "") || "https://gateway.pinata.cloud/ipfs";
}

/** A public URL for consumers outside this app (wallets, explorers, metadata). */
export function gatewayUrlFor(value: string | null | undefined): string {
  const cid = mediaCid(value);
  if (cid) return `${ipfsGateway()}/${cid}`;
  return value ?? "";
}

export const FALLBACK_GATEWAYS = [
  "https://gateway.pinata.cloud/ipfs",
  "https://ipfs.io/ipfs",
  "https://w3s.link/ipfs",
  "https://dweb.link/ipfs",
];

export function gateways(): string[] {
  const configured = process.env.NEXT_PUBLIC_IPFS_GATEWAY?.replace(/\/$/, "");
  return [...new Set(configured ? [configured, ...FALLBACK_GATEWAYS] : FALLBACK_GATEWAYS)];
}
