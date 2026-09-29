import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";

import { normAddress, type Address } from "./address";
import { CallerError } from "./api";
import { publicClient, type ChainId } from "./chains";

/**
 * Wallet sessions for social writes.
 *
 * A like, comment, follow, watchlist entry, plan, post or upload is stored
 * against a wallet, so the server has to know the caller controls it. Asking
 * for a signature on every like would be a wallet prompt per heart, so the
 * wallet signs once:
 *
 *   `Juno session\nWallet: ${lowercaseAddress}\nIssued: ${isoTime}`
 *
 * (EIP-191 `personal_sign`, accepted within 10 minutes of `Issued`), and gets
 * back a token good for 7 days: `base64url(payload).base64url(hmac)`, the HMAC
 * keyed by `JUNO_SESSION_SECRET`. Writes send it as `Authorization: Bearer …`
 * and the route checks it names the wallet the write is for.
 */

const SESSION_DAYS = 7;
const SIGNATURE_WINDOW_MS = 10 * 60 * 1000;

export function sessionMessage(wallet: string, issuedAt: string): string {
  return `Juno session\nWallet: ${wallet.toLowerCase()}\nIssued: ${issuedAt}`;
}

function secret(): Buffer {
  const value = process.env.JUNO_SESSION_SECRET;
  if (!value || value.length < 32) throw new CallerError("Wallet sessions are not configured on this server.", 503);
  return Buffer.from(value, "utf8");
}

const b64 = (data: Buffer | string) => Buffer.from(data).toString("base64url");
const mac = (payload: string) => createHmac("sha256", secret()).update(payload).digest();

export type Session = { wallet: Address; expiresAt: number };

/** Verify a signed session request and issue a token. */
export async function openSession(input: {
  chainId: ChainId;
  wallet: unknown;
  issuedAt: unknown;
  signature: unknown;
}): Promise<Session & { token: string }> {
  const wallet = normAddress(input.wallet, "wallet");
  if (typeof input.issuedAt !== "string" || Number.isNaN(Date.parse(input.issuedAt))) {
    throw new CallerError("issuedAt must be an ISO time");
  }
  const age = Date.now() - Date.parse(input.issuedAt);
  if (age > SIGNATURE_WINDOW_MS || age < -60_000) {
    throw new CallerError("This signature is too old. Sign again.", 400, { reason: "Expired" });
  }
  if (typeof input.signature !== "string" || !/^0x[0-9a-fA-F]+$/.test(input.signature)) {
    throw new CallerError("signature must be 0x hex");
  }
  // publicClient.verifyMessage covers plain EOAs (Privy's embedded wallet) and
  // smart-contract wallets (ERC-1271 / ERC-6492) alike.
  const valid = await publicClient(input.chainId)
    .verifyMessage({
      address: wallet,
      message: sessionMessage(wallet, input.issuedAt),
      signature: input.signature as `0x${string}`,
    })
    .catch(() => false);
  if (!valid) throw new CallerError("That signature is not from this wallet.", 401, { reason: "BadSignature" });

  const expiresAt = Date.now() + SESSION_DAYS * 24 * 3600 * 1000;
  const payload = b64(JSON.stringify({ v: 1, w: wallet, exp: expiresAt }));
  return { wallet, expiresAt, token: `${payload}.${b64(mac(payload))}` };
}

/** The session a request carries, or null (no header, bad MAC, expired). */
export function readSession(request: Request): Session | null {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(header.trim());
  if (!match) return null;
  const [, payload, signature] = match;
  const expected = mac(payload);
  const given = Buffer.from(signature, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { v: number; w: string; exp: number };
    if (data.v !== 1 || typeof data.exp !== "number" || data.exp < Date.now()) return null;
    return { wallet: normAddress(data.w), expiresAt: data.exp };
  } catch {
    return null;
  }
}

/**
 * The caller's session, required. With `wallet`, the session must be that
 * wallet's: a write stored against a wallet can only come from it.
 */
export function requireSession(request: Request, wallet?: string): Session {
  const session = readSession(request);
  if (!session) {
    throw new CallerError("Sign in with your wallet to do this.", 401, { reason: "NoSession" });
  }
  if (wallet !== undefined && session.wallet !== wallet.toLowerCase()) {
    throw new CallerError("This session belongs to a different wallet.", 403, { reason: "WrongWallet" });
  }
  return session;
}
