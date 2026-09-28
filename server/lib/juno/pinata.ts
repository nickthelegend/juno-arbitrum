/**
 * IPFS pinning via Pinata: the media a creator uploads, and the token
 * metadata JSON a launch points at. The URI is baked into the token at
 * launch, so it is pinned first.
 *
 * A runtime guard rather than `server-only`, so scripts can share it.
 */
import { ipfsGateway } from "./media";

const PINATA_API = "https://api.pinata.cloud";

function jwt(): string {
  if (typeof window !== "undefined") throw new Error("Pinata must be called from the server");
  const token = process.env.PINATA_JWT;
  if (!token) throw new Error("PINATA_JWT is not set");
  return token;
}

export type PinResult = { cid: string; uri: string; url: string };

function toResult(cid: string): PinResult {
  return { cid, uri: `ipfs://${cid}`, url: `${ipfsGateway()}/${cid}` };
}

export async function pinFile(file: File, name?: string): Promise<PinResult> {
  const form = new FormData();
  form.append("file", file, file.name || "upload");
  form.append("pinataMetadata", JSON.stringify({ name: name ?? file.name ?? "juno-media" }));
  const response = await fetch(`${PINATA_API}/pinning/pinFileToIPFS`, {
    method: "POST",
    headers: { Authorization: `Bearer ${jwt()}` },
    body: form,
  });
  if (!response.ok) throw new Error(`Pinata upload failed (${response.status}): ${await response.text()}`);
  const body = (await response.json()) as { IpfsHash: string };
  return toResult(body.IpfsHash);
}

export async function pinJson(content: unknown, name: string): Promise<PinResult> {
  const response = await fetch(`${PINATA_API}/pinning/pinJSONToIPFS`, {
    method: "POST",
    headers: { Authorization: `Bearer ${jwt()}`, "content-type": "application/json" },
    body: JSON.stringify({ pinataContent: content, pinataMetadata: { name } }),
  });
  if (!response.ok) throw new Error(`Pinata JSON pin failed (${response.status}): ${await response.text()}`);
  const body = (await response.json()) as { IpfsHash: string };
  return toResult(body.IpfsHash);
}
