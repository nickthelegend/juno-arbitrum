import { isAddress, zeroAddress } from "viem";

import { CallerError } from "./api";

/**
 * The one address check every route uses.
 *
 * Addresses are 0x-prefixed, 40 hex characters. Checksums are accepted but not
 * required (a lowercase address from a URL is valid), and the result is always
 * lowercase — that is how they are stored and compared everywhere server-side.
 */
export type Address = `0x${string}`;

export function isAddr(value: unknown): value is string {
  return typeof value === "string" && isAddress(value.trim(), { strict: false });
}

/** Lowercase the address, or throw a 400 naming the field. */
export function normAddress(value: unknown, field = "address"): Address {
  if (!isAddr(value)) throw new CallerError(`${field} is not an address`);
  return value.trim().toLowerCase() as Address;
}

/** Lowercase the address, or null when absent or malformed. */
export function maybeAddress(value: unknown): Address | null {
  return isAddr(value) ? (value.trim().toLowerCase() as Address) : null;
}

/**
 * A comma-separated list of addresses (a batch lookup), lowercased and
 * de-duplicated. Any entry that is not an address is a 400 naming the field,
 * rather than being dropped: a caller with a bad id should hear about it.
 */
export function addressList(value: string | null, field: string, max: number): Address[] {
  const entries = (value ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);
  const bad = entries.find((entry) => !isAddr(entry));
  if (bad !== undefined) throw new CallerError(`${field} contains something that is not an address`);
  return [...new Set(entries.map((entry) => entry.toLowerCase() as Address))].slice(0, max);
}

/** The zero address means "none" in contract structs (native ETH, no feed). */
export function nonZero(value: string | null | undefined): Address | null {
  if (!value) return null;
  const lower = value.toLowerCase();
  return lower === zeroAddress ? null : (lower as Address);
}
