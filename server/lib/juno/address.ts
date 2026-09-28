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

/** The zero address means "none" in contract structs (native ETH, no feed). */
export function nonZero(value: string | null | undefined): Address | null {
  if (!value) return null;
  const lower = value.toLowerCase();
  return lower === zeroAddress ? null : (lower as Address);
}
