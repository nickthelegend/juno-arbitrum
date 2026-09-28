/**
 * Type-checking entry only. Metro never bundles this file: it picks
 * `privy.native.tsx` on iOS and Android and `privy.web.tsx` in the browser.
 * Both export the same names with the same types, so `tsc` checks every
 * import of `./privy` against the web one.
 */
export * from "./privy.web";
