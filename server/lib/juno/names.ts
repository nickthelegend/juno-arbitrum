import { verifyMessage } from "viem";

import { isAddr } from "./address";
import { CallerError } from "./api";

/**
 * Name claims, verified with EIP-191 (`personal_sign`).
 *
 * A name is proven by the wallet that owns it: the wallet signs exactly
 * `Juno name: ${name}\nWallet: ${lowercaseAddress}\nIssued: ${isoTime}`, and
 * the claim is accepted within ten minutes of `Issued`. Pure — storage is in
 * `profiles.ts` — so the rules are testable with a local key.
 */

export const NAME = /^[a-z0-9_]{3,20}$/;
export const RESERVED = new Set(["juno", "admin", "support", "official", "arbitrum", "chainlink", "uniswap"]);
/** How old a signed claim may be. Long enough for a slow phone, short enough not to replay. */
export const MAX_AGE_MS = 10 * 60_000;

export function nameMessage(wallet: string, name: string, issuedAt: string): string {
  return `Juno name: ${name}\nWallet: ${wallet.toLowerCase()}\nIssued: ${issuedAt}`;
}

export type NameClaim = { wallet: string; name: string; issuedAt: string; signature: string };

/**
 * Check a claim. Returns the lowercase wallet, the name as typed and its
 * case-folded key; throws a `CallerError` naming what is wrong.
 *
 * `fallbackVerify` lets the caller try a chain-aware check (ERC-1271 smart
 * accounts) when the plain ECDSA recovery does not match.
 */
export async function verifyNameClaim(
  claim: NameClaim,
  options: {
    now?: number;
    fallbackVerify?: (input: { address: `0x${string}`; message: string; signature: `0x${string}` }) => Promise<boolean>;
  } = {},
): Promise<{ wallet: string; name: string; nameKey: string }> {
  const name = claim.name.trim();
  const key = name.toLowerCase();
  if (!NAME.test(key)) throw new CallerError("Names are 3–20 characters: letters, digits and underscores.");
  if (RESERVED.has(key)) throw new CallerError("That name is reserved.");
  if (!isAddr(claim.wallet)) throw new CallerError("wallet is not an address");
  const wallet = claim.wallet.trim().toLowerCase() as `0x${string}`;

  const issued = Date.parse(claim.issuedAt);
  const now = options.now ?? Date.now();
  if (!Number.isFinite(issued) || Math.abs(now - issued) > MAX_AGE_MS) {
    throw new CallerError("That request has expired. Try again.");
  }
  if (!/^0x[0-9a-fA-F]+$/.test(claim.signature)) throw new CallerError("The signature is not valid.");
  const signature = claim.signature as `0x${string}`;
  const message = nameMessage(wallet, name, claim.issuedAt);

  let valid = false;
  try {
    valid = await verifyMessage({ address: wallet, message, signature });
  } catch {
    valid = false;
  }
  if (!valid && options.fallbackVerify) {
    valid = await options.fallbackVerify({ address: wallet, message, signature }).catch(() => false);
  }
  if (!valid) throw new CallerError("The signature does not match this wallet.");
  return { wallet, name, nameKey: key };
}
