/**
 * Node globals that React Native does not have, installed before anything else.
 *
 * `@solana/web3.js` is built for Node and the browser. Two things it assumes
 * are simply absent in Hermes:
 *
 * `Buffer` — transaction serialisation is Buffer-based throughout, and every
 * `Transaction.from(...)` call would throw `Buffer is not defined` without it.
 *
 * `crypto.getRandomValues` — used when generating a keypair and when signing.
 * `react-native-get-random-values` must be imported for its side effect, and
 * it must come first: a module that reads `crypto` at import time would
 * otherwise capture the unpatched object.
 *
 * This file is imported at the very top of the root layout for that reason.
 * Ordering here is not stylistic — it is the difference between a working app
 * and a crash on the first signature.
 */

import "react-native-get-random-values";
// Privy encodes and decodes text before Hermes has a TextEncoder for it.
import "fast-text-encoding";
import { Buffer } from "buffer";

declare global {
  // eslint-disable-next-line no-var
  var Buffer: typeof import("buffer").Buffer;
}

if (typeof globalThis.Buffer === "undefined") {
  globalThis.Buffer = Buffer;
}

export {};
