import { beforeAll, describe, expect, it, vi } from "vitest";
import { verifyMessage } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

/**
 * Wallet sessions: a real EIP-191 signature opens one, and only an untampered,
 * unexpired token for the same wallet passes `requireSession`. The chain client
 * is replaced by viem's local `verifyMessage` (what the RPC path does for an EOA).
 */

vi.mock("@/lib/juno/chains", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/juno/chains")>();
  return { ...actual, publicClient: () => ({ verifyMessage }) };
});

const { openSession, readSession, requireSession, sessionMessage } = await import("@/lib/juno/session");
const { CallerError } = await import("@/lib/juno/api");

const alice = privateKeyToAccount(generatePrivateKey());
const bob = privateKeyToAccount(generatePrivateKey());

beforeAll(() => {
  process.env.JUNO_SESSION_SECRET = "test-secret-that-is-at-least-32-characters-long";
});

async function signed(account = alice, issuedAt = new Date().toISOString(), wallet = account.address) {
  const signature = await account.signMessage({ message: sessionMessage(wallet, issuedAt) });
  return { chainId: 421614 as const, wallet, issuedAt, signature };
}

const bearer = (token: string) => new Request("https://x/api", { headers: { authorization: `Bearer ${token}` } });

async function rejection(promise: Promise<unknown> | (() => unknown)) {
  try {
    await (typeof promise === "function" ? promise() : promise);
  } catch (error) {
    return error as InstanceType<typeof CallerError>;
  }
  throw new Error("expected a rejection");
}

describe("wallet sessions", () => {
  it("opens a session for a valid signature and reads it back", async () => {
    const session = await openSession(await signed());
    expect(session.wallet).toBe(alice.address.toLowerCase());
    expect(session.expiresAt).toBeGreaterThan(Date.now() + 6 * 24 * 3600 * 1000);
    expect(readSession(bearer(session.token))).toEqual({ wallet: alice.address.toLowerCase(), expiresAt: session.expiresAt });
    expect(requireSession(bearer(session.token), alice.address).wallet).toBe(alice.address.toLowerCase());
  });

  it("refuses a signature from another wallet", async () => {
    const forged = await signed(bob, new Date().toISOString(), alice.address);
    const error = await rejection(openSession(forged));
    expect(error.status).toBe(401);
    expect(error.extra.reason).toBe("BadSignature");
  });

  it("refuses a signature older than ten minutes", async () => {
    const error = await rejection(openSession(await signed(alice, new Date(Date.now() - 11 * 60 * 1000).toISOString())));
    expect(error.status).toBe(400);
  });

  it("rejects a tampered token, a missing one, and another wallet's", async () => {
    const { token } = await openSession(await signed());
    const [payload, mac] = token.split(".");
    const other = Buffer.from(JSON.stringify({ v: 1, w: bob.address.toLowerCase(), exp: Date.now() + 1e9 })).toString("base64url");
    expect(readSession(bearer(`${other}.${mac}`))).toBeNull();
    expect(readSession(bearer(`${payload}.${mac.slice(0, -2)}AA`))).toBeNull();
    expect(readSession(new Request("https://x/api"))).toBeNull();
    expect((await rejection(() => requireSession(new Request("https://x/api"), alice.address))).status).toBe(401);
    expect((await rejection(() => requireSession(bearer(token), bob.address))).status).toBe(403);
  });

  it("rejects an expired token", async () => {
    const { token } = await openSession(await signed());
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 8 * 24 * 3600 * 1000);
    expect(readSession(bearer(token))).toBeNull();
    vi.useRealTimers();
  });

  it("says so when the server has no session secret", async () => {
    const saved = process.env.JUNO_SESSION_SECRET;
    delete process.env.JUNO_SESSION_SECRET;
    const error = await rejection(openSession(await signed()));
    expect(error.status).toBe(503);
    process.env.JUNO_SESSION_SECRET = saved;
  });
});
