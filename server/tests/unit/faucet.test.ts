import { describe, expect, it } from "vitest";

import { PER_IP, WINDOW_MS, rateDecision, retryMessage, type FaucetClaim } from "@/lib/juno/faucet";

/** The faucet's limits: one drip per wallet and three per IP in any 24 hours. */

const NOW = Date.parse("2026-09-28T12:00:00Z");
const HOUR = 60 * 60 * 1000;
const claim = (wallet: string, ip: string, agoMs: number): FaucetClaim => ({ wallet, ip, at: new Date(NOW - agoMs) });

describe("rateDecision", () => {
  it("lets a new wallet through", () => {
    expect(rateDecision([], "0xa", "1.1.1.1", NOW)).toEqual({ ok: true });
  });

  it("allows one drip per wallet per day and says when the next is due", () => {
    const decision = rateDecision([claim("0xa", "1.1.1.1", 3 * HOUR)], "0xa", "2.2.2.2", NOW);
    expect(decision).toEqual({ ok: false, scope: "wallet", retryAfterSeconds: 21 * 60 * 60 });
  });

  it("forgets a claim once it is a day old", () => {
    expect(rateDecision([claim("0xa", "1.1.1.1", WINDOW_MS + 1)], "0xa", "1.1.1.1", NOW)).toEqual({ ok: true });
  });

  it("allows three wallets per IP, then waits for the oldest that still counts", () => {
    const claims = [
      claim("0xa", "9.9.9.9", 1 * HOUR),
      claim("0xb", "9.9.9.9", 5 * HOUR),
      claim("0xc", "9.9.9.9", 10 * HOUR),
    ];
    expect(PER_IP).toBe(3);
    expect(rateDecision(claims.slice(0, 2), "0xd", "9.9.9.9", NOW)).toEqual({ ok: true });
    expect(rateDecision(claims, "0xd", "9.9.9.9", NOW)).toEqual({ ok: false, scope: "ip", retryAfterSeconds: 14 * 60 * 60 });
  });

  it("does not pool every caller whose IP is unknown", () => {
    const claims = [claim("0xa", "unknown", HOUR), claim("0xb", "unknown", HOUR), claim("0xc", "unknown", HOUR)];
    expect(rateDecision(claims, "0xd", "unknown", NOW)).toEqual({ ok: true });
  });

  it("explains the wait in hours and minutes", () => {
    expect(retryMessage({ ok: false, scope: "wallet", retryAfterSeconds: 21 * 3600 + 90 })).toBe(
      "This wallet already used the faucet today. Try again in 21h 2m.",
    );
    expect(retryMessage({ ok: false, scope: "ip", retryAfterSeconds: 600 })).toMatch(/10 min/);
    // Just under a day rounds up to a whole day, never "23h 60m".
    expect(retryMessage({ ok: false, scope: "wallet", retryAfterSeconds: 86_399 })).toMatch(/24h 0m/);
  });
});
