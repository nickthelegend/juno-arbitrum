/**
 * Globals Hermes does not have, installed before anything else on iOS and Android.
 *
 * - `crypto.getRandomValues`: Privy and viem both draw randomness from it.
 *   `react-native-get-random-values` must come first, because a module that
 *   reads `crypto` at import time would otherwise capture the unpatched object.
 * - `TextEncoder`/`TextDecoder`: Privy encodes and decodes text before Hermes
 *   has them.
 * - `Buffer`: Privy's core SDK calls the global `Buffer` in its EVM signing
 *   path (hex-encoding messages and typed transactions), so it has to exist.
 *
 * Imported at the very top of the root layout. The browser has all three, so
 * the web build resolves `polyfills.ts`, which is empty.
 */

import "react-native-get-random-values";
import "fast-text-encoding";
import { Buffer } from "buffer";

const scope = globalThis as { Buffer?: unknown };
if (typeof scope.Buffer === "undefined") {
  scope.Buffer = Buffer;
}

export {};
