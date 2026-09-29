import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";

import { API_URL, ApiError } from "./api";
import { CHAIN_ID } from "./chain";

/**
 * The wallet session social writes carry.
 *
 * Likes, comments, follows, the watchlist, plans, posts and uploads are stored
 * against a wallet, so the server wants proof the caller controls it. The
 * wallet signs one message —
 *
 *   `Juno session\nWallet: ${lowercaseAddress}\nIssued: ${isoTime}`
 *
 * — and the server returns a token good for 7 days, kept in SecureStore on a
 * phone and localStorage on the web. One signature, then every write rides on
 * the token. The wallet provider registers the signer when a wallet connects.
 */

type Signer = { wallet: string; sign: (text: string) => Promise<string> };
type Stored = { token: string; expiresAt: number };

let signer: Signer | null = null;
const memory = new Map<string, Stored>();
const pending = new Map<string, Promise<Stored>>();

export function sessionMessage(wallet: string, issuedAt: string): string {
  return `Juno session\nWallet: ${wallet.toLowerCase()}\nIssued: ${issuedAt}`;
}

/** Called by the wallet provider as wallets come and go. */
export function setSessionSigner(next: Signer | null): void {
  signer = next ? { ...next, wallet: next.wallet.toLowerCase() } : null;
}

/** The wallet writes are made as, when one is connected. */
export function sessionWallet(): string | null {
  return signer?.wallet ?? null;
}

const storageKey = (wallet: string) => `juno_session_${CHAIN_ID}_${wallet.toLowerCase()}`;

async function load(wallet: string): Promise<Stored | null> {
  const cached = memory.get(wallet);
  if (cached) return cached;
  try {
    const raw =
      Platform.OS === "web" ? globalThis.localStorage?.getItem(storageKey(wallet)) : await SecureStore.getItemAsync(storageKey(wallet));
    if (!raw) return null;
    const stored = JSON.parse(raw) as Stored;
    memory.set(wallet, stored);
    return stored;
  } catch {
    return null;
  }
}

async function save(wallet: string, stored: Stored | null): Promise<void> {
  if (stored) memory.set(wallet, stored);
  else memory.delete(wallet);
  try {
    if (Platform.OS === "web") {
      if (stored) globalThis.localStorage?.setItem(storageKey(wallet), JSON.stringify(stored));
      else globalThis.localStorage?.removeItem(storageKey(wallet));
    } else if (stored) {
      await SecureStore.setItemAsync(storageKey(wallet), JSON.stringify(stored));
    } else {
      await SecureStore.deleteItemAsync(storageKey(wallet));
    }
  } catch {
    // Storage refused (private mode): the session lives for this run only.
  }
}

async function open(wallet: string): Promise<Stored> {
  if (!signer || signer.wallet !== wallet) {
    throw new ApiError("Sign in with this wallet first.", 401, { reason: "NoSession" });
  }
  const issuedAt = new Date().toISOString();
  const signature = await signer.sign(sessionMessage(wallet, issuedAt));
  const response = await fetch(`${API_URL}/api/juno/session`, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ chainId: CHAIN_ID, wallet, issuedAt, signature }),
  });
  const body = (await response.json().catch(() => null)) as { token?: string; expiresAt?: number; error?: string } | null;
  if (!response.ok || !body?.token || !body.expiresAt) {
    throw new ApiError(body?.error ?? `Could not start a session (${response.status})`, response.status, body);
  }
  const stored = { token: body.token, expiresAt: body.expiresAt };
  await save(wallet, stored);
  return stored;
}

/**
 * The `Authorization` header for a write as `wallet` (the connected wallet
 * when omitted). Signs once when there is no live session; concurrent writes
 * share the one signature.
 */
export async function sessionHeaders(walletInput?: string): Promise<Record<string, string>> {
  const wallet = (walletInput ?? signer?.wallet ?? "").toLowerCase();
  if (!wallet) throw new ApiError("Sign in to do this.", 401, { reason: "NoSession" });
  const cached = await load(wallet);
  if (cached && cached.expiresAt > Date.now() + 60_000) return { authorization: `Bearer ${cached.token}` };
  let inflight = pending.get(wallet);
  if (!inflight) {
    inflight = open(wallet).finally(() => pending.delete(wallet));
    pending.set(wallet, inflight);
  }
  const stored = await inflight;
  return { authorization: `Bearer ${stored.token}` };
}

/** Drop a session the server refused, so the next write signs a fresh one. */
export async function forgetSession(walletInput?: string): Promise<void> {
  const wallet = (walletInput ?? signer?.wallet ?? "").toLowerCase();
  if (wallet) await save(wallet, null);
}
