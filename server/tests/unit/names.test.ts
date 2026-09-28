import { describe, expect, it } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { CallerError } from "@/lib/juno/api";
import { MAX_AGE_MS, nameMessage, verifyNameClaim } from "@/lib/juno/names";

/**
 * EIP-191 name claims, signed with a real local key — the same
 * `personal_sign` a Privy wallet performs.
 */

const account = privateKeyToAccount(generatePrivateKey());
const other = privateKeyToAccount(generatePrivateKey());
const NOW = Date.parse("2026-09-28T12:00:00.000Z");
const issuedAt = new Date(NOW - 60_000).toISOString();

async function signed(name: string, signer = account, wallet: string = account.address, at = issuedAt) {
  const signature = await signer.signMessage({ message: nameMessage(wallet, name, at) });
  return { wallet, name, issuedAt: at, signature };
}

async function rejection(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(CallerError);
    return (error as Error).message;
  }
  throw new Error("expected a rejection");
}

describe("nameMessage", () => {
  it("is exactly the documented text, with the wallet lowercased", () => {
    expect(nameMessage("0xAbC0000000000000000000000000000000000001", "alice", "2026-09-28T12:00:00.000Z")).toBe(
      "Juno name: alice\nWallet: 0xabc0000000000000000000000000000000000001\nIssued: 2026-09-28T12:00:00.000Z",
    );
  });
});

describe("verifyNameClaim", () => {
  it("accepts a claim signed by the wallet, from a checksummed address", async () => {
    const result = await verifyNameClaim(await signed("Alice_1"), { now: NOW });
    expect(result).toEqual({ wallet: account.address.toLowerCase(), name: "Alice_1", nameKey: "alice_1" });
  });

  it("rejects a signature from another key", async () => {
    const claim = await signed("alice", other);
    expect(await rejection(verifyNameClaim(claim, { now: NOW }))).toMatch(/does not match/);
  });

  it("rejects a claim for a different name than was signed", async () => {
    const claim = { ...(await signed("alice")), name: "mallory" };
    expect(await rejection(verifyNameClaim(claim, { now: NOW }))).toMatch(/does not match/);
  });

  it("rejects a claim outside the ten-minute window", async () => {
    const old = new Date(NOW - MAX_AGE_MS - 1_000).toISOString();
    const claim = await signed("alice", account, account.address, old);
    expect(await rejection(verifyNameClaim(claim, { now: NOW }))).toMatch(/expired/);
  });

  it("rejects reserved and malformed names before checking a signature", async () => {
    expect(await rejection(verifyNameClaim(await signed("arbitrum"), { now: NOW }))).toMatch(/reserved/);
    expect(await rejection(verifyNameClaim(await signed("no spaces"), { now: NOW }))).toMatch(/3–20/);
    expect(await rejection(verifyNameClaim(await signed("ab"), { now: NOW }))).toMatch(/3–20/);
  });

  it("rejects a non-address and a non-hex signature", async () => {
    const claim = await signed("alice");
    expect(await rejection(verifyNameClaim({ ...claim, wallet: "not-a-wallet" }, { now: NOW }))).toMatch(/not an address/);
    expect(await rejection(verifyNameClaim({ ...claim, signature: "base58sig" }, { now: NOW }))).toMatch(/not valid/);
  });

  it("falls back to a chain check (ERC-1271) when recovery does not match", async () => {
    const claim = await signed("alice", other);
    const result = await verifyNameClaim(claim, { now: NOW, fallbackVerify: async () => true });
    expect(result.nameKey).toBe("alice");
  });
});
